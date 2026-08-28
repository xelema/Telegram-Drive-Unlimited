import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

val keystorePropertiesFile = file("keystore.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) {
        keystorePropertiesFile.inputStream().use { load(it) }
    }
}

val copyAndroidCppRuntime by tasks.registering(Copy::class) {
    val sdkRoot = providers.environmentVariable("ANDROID_HOME")
        .orElse(providers.environmentVariable("ANDROID_SDK_ROOT"))
        .orElse("${System.getProperty("user.home")}/Library/Android/sdk")
    val ndkVersion = providers.gradleProperty("android.ndkVersion").orElse("30.0.14904198")
    val hostOs = System.getProperty("os.name").lowercase()
    val hostArch = System.getProperty("os.arch").lowercase()
    val hostTag = when {
        hostOs.contains("mac") && hostArch.contains("aarch64") -> "darwin-aarch64"
        hostOs.contains("mac") -> "darwin-x86_64"
        hostOs.contains("win") -> "windows-x86_64"
        else -> "linux-x86_64"
    }
    val ndkSysroot = sdkRoot.map {
        file("$it/ndk/${ndkVersion.get()}/toolchains/llvm/prebuilt/$hostTag/sysroot/usr/lib")
    }

    from(ndkSysroot.map { file("$it/aarch64-linux-android/libc++_shared.so") }) {
        into("arm64-v8a")
    }
    from(ndkSysroot.map { file("$it/arm-linux-androideabi/libc++_shared.so") }) {
        into("armeabi-v7a")
    }
    from(ndkSysroot.map { file("$it/i686-linux-android/libc++_shared.so") }) {
        into("x86")
    }
    from(ndkSysroot.map { file("$it/x86_64-linux-android/libc++_shared.so") }) {
        into("x86_64")
    }
    into(layout.projectDirectory.dir("src/main/jniLibs"))
}

android {
    compileSdk = 36
    ndkVersion = "30.0.14904198"
    namespace = "com.cameronamer.telegramdrive"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.cameronamer.telegramdrive"
        minSdk = 24
        targetSdk = 36
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    packaging {
        jniLibs {
            useLegacyPackaging = false
        }
    }
    signingConfigs {
        if (keystorePropertiesFile.exists()) {
            create("release") {
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["keyPassword"] as String
                storeFile = file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["storePassword"] as String
                enableV1Signing = true
                enableV2Signing = true
                enableV3Signing = true
                enableV4Signing = true
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            manifestPlaceholders["usesCleartextTraffic"] = "false"
            if (keystorePropertiesFile.exists()) {
                signingConfig = signingConfigs.getByName("release")
            }
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

val requireReleaseSigning = providers.gradleProperty("telegramDrive.requireReleaseSigning")
    .map(String::toBoolean)
    .orElse(false)

tasks.configureEach {
    if (name.contains("Release", ignoreCase = true)) {
        doFirst {
            if (requireReleaseSigning.get() && !keystorePropertiesFile.exists()) {
                throw GradleException(
                    "A protected release signing configuration is required for production Android builds."
                )
            }
        }
    }
}

tasks.matching { it.name.contains("merge", ignoreCase = true) && it.name.contains("JniLibFolders", ignoreCase = true) }
    .configureEach {
        dependsOn(copyAndroidCppRuntime)
    }

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.work:work-runtime-ktx:2.10.1")
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("androidx.profileinstaller:profileinstaller:1.4.1")
    // Tauri's generated Android project currently compiles with Kotlin 1.9.
    // Media3 1.4 retains that metadata compatibility while providing the
    // ExoPlayer range-streaming, controls, and PiP APIs used by the app.
    implementation("androidx.media3:media3-exoplayer:1.4.1")
    implementation("androidx.media3:media3-ui:1.4.1")
    implementation("androidx.media3:media3-session:1.4.1")
    implementation("com.google.android.material:material:1.12.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test:core:1.6.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
}

apply(from = "tauri.build.gradle.kts")
