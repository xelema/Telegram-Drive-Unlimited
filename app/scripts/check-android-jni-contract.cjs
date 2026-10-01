#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const repositoryRoot = path.resolve(appRoot, '..');
const overridesRoot = path.join(appRoot, 'android-overrides');
const generatedRoot = path.join(appRoot, 'src-tauri', 'gen', 'android');
const arguments = process.argv.slice(2);
const requireGenerated = arguments.includes('--generated');
const r8SeedsFlag = arguments.indexOf('--r8-seeds');

if (r8SeedsFlag !== -1 && !arguments[r8SeedsFlag + 1]) {
  throw new Error('`--r8-seeds` requires a path to an R8 seeds file.');
}

const r8SeedsPath = r8SeedsFlag === -1
  ? null
  : path.resolve(appRoot, arguments[r8SeedsFlag + 1]);

const classes = [
  {
    className: 'com.cameronamer.telegramdrive.MainActivity',
    rustCallSymbol: 'main_class',
    rustFiles: [
      'src-tauri/src/lib.rs',
      'src-tauri/src/commands/fs.rs',
      'src-tauri/src/commands/network.rs',
      'src-tauri/src/commands/supporter.rs',
      'src-tauri/src/android_security.rs',
      'src-tauri/src/android_updates.rs',
    ],
    kotlinFile: 'app/src/main/java/com/cameronamer/telegramdrive/MainActivity.kt',
    methods: [
      {
        name: 'authenticateForSensitiveAction',
        descriptor: '(Ljava/lang/String;)Z',
        kotlin: 'fun authenticateForSensitiveAction(reason: String): Boolean',
        r8: 'boolean authenticateForSensitiveAction(java.lang.String)',
      },
      {
        name: 'configurePrivacy',
        descriptor: '(ZZI)Z',
        kotlin: 'fun configurePrivacy(biometricLock: Boolean, privacyScreen: Boolean, timeoutMinutes: Int): Boolean',
        r8: 'boolean configurePrivacy(boolean,boolean,int)',
      },
      {
        name: 'configureTransferRecovery',
        descriptor: '(ZZZZ)V',
        kotlin: 'fun configureTransferRecovery( wifiOnly: Boolean, allowRoaming: Boolean, requireCharging: Boolean, pauseOnLowBattery: Boolean, )',
        r8: 'void configureTransferRecovery(boolean,boolean,boolean,boolean)',
      },
      {
        name: 'deleteSupporterSecret',
        descriptor: '(Ljava/lang/String;)Z',
        kotlin: 'fun deleteSupporterSecret(account: String): Boolean',
        r8: 'boolean deleteSupporterSecret(java.lang.String)',
      },
      {
        name: 'getAndClearShareCount',
        descriptor: '()I',
        kotlin: 'fun getAndClearShareCount(): Int',
        r8: 'int getAndClearShareCount()',
      },
      {
        name: 'getAndClearPendingTransferAction',
        descriptor: '()Ljava/lang/String;',
        kotlin: 'fun getAndClearPendingTransferAction(): String',
        r8: 'java.lang.String getAndClearPendingTransferAction()',
      },
      {
        name: 'getCachedPath',
        descriptor: '(Ljava/lang/String;)Ljava/lang/String;',
        kotlin: 'fun getCachedPath(uriString: String): String',
        r8: 'java.lang.String getCachedPath(java.lang.String)',
      },
      {
        name: 'getInstalledVersionCode',
        descriptor: '()J',
        kotlin: 'fun getInstalledVersionCode(): Long',
        r8: 'long getInstalledVersionCode()',
      },
      {
        name: 'getLocalFileFromUri',
        descriptor: '(Ljava/lang/String;)Ljava/lang/String;',
        kotlin: 'fun getLocalFileFromUri(uriString: String): String',
        r8: 'java.lang.String getLocalFileFromUri(java.lang.String)',
      },
      {
        name: 'getPlaybackHistory',
        descriptor: '()Ljava/lang/String;',
        kotlin: 'fun getPlaybackHistory(): String',
        r8: 'java.lang.String getPlaybackHistory()',
      },
      {
        name: 'getSupporterSecret',
        descriptor: '(Ljava/lang/String;)Ljava/lang/String;',
        kotlin: 'fun getSupporterSecret(account: String): String',
        r8: 'java.lang.String getSupporterSecret(java.lang.String)',
      },
      {
        name: 'getSystemDiagnosticsJson',
        descriptor: '()Ljava/lang/String;',
        kotlin: 'fun getSystemDiagnosticsJson(): String',
        r8: 'java.lang.String getSystemDiagnosticsJson()',
      },
      {
        name: 'getTransferEnvironmentJson',
        descriptor: '()Ljava/lang/String;',
        kotlin: 'fun getTransferEnvironmentJson(): String',
        r8: 'java.lang.String getTransferEnvironmentJson()',
      },
      {
        name: 'installVerifiedApk',
        descriptor: '(Ljava/lang/String;)I',
        kotlin: 'fun installVerifiedApk(cachePath: String): Int',
        r8: 'int installVerifiedApk(java.lang.String)',
      },
      {
        name: 'isDeviceAuthenticationAvailable',
        descriptor: '()Z',
        kotlin: 'fun isDeviceAuthenticationAvailable(): Boolean',
        r8: 'boolean isDeviceAuthenticationAvailable()',
      },
      {
        name: 'isNetworkAvailable',
        descriptor: '()Z',
        kotlin: 'fun isNetworkAvailable(): Boolean',
        r8: 'boolean isNetworkAvailable()',
      },
      {
        name: 'listCachedFiles',
        descriptor: '()Ljava/lang/String;',
        kotlin: 'fun listCachedFiles(): String',
        r8: 'java.lang.String listCachedFiles()',
      },
      {
        name: 'openFileExternally',
        descriptor: '(Ljava/lang/String;Ljava/lang/String;)Z',
        kotlin: 'fun openFileExternally(cachePath: String, mimeType: String): Boolean',
        r8: 'boolean openFileExternally(java.lang.String,java.lang.String)',
      },
      {
        name: 'openMediaStream',
        descriptor: '(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Z',
        kotlin: 'fun openMediaStream(streamUrl: String, title: String, mimeType: String, mediaId: String, preferences: String): Boolean',
        r8: 'boolean openMediaStream(java.lang.String,java.lang.String,java.lang.String,java.lang.String,java.lang.String)',
      },
      {
        name: 'putSupporterSecret',
        descriptor: '(Ljava/lang/String;Ljava/lang/String;)Z',
        kotlin: 'fun putSupporterSecret(account: String, value: String): Boolean',
        r8: 'boolean putSupporterSecret(java.lang.String,java.lang.String)',
      },
      {
        name: 'removeCachedPath',
        descriptor: '(Ljava/lang/String;)V',
        kotlin: 'fun removeCachedPath(uriString: String)',
        r8: 'void removeCachedPath(java.lang.String)',
      },
      {
        name: 'saveFileToPublicDownloads',
        descriptor: '(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Z',
        kotlin: 'fun saveFileToPublicDownloads(cachePath: String, fileName: String, mimeType: String): Boolean',
        r8: 'boolean saveFileToPublicDownloads(java.lang.String,java.lang.String,java.lang.String)',
      },
    ],
  },
  {
    className: 'com.cameronamer.telegramdrive.UploadForegroundService',
    rustCallSymbol: 'j_class',
    rustFiles: ['src-tauri/src/upload_service.rs'],
    kotlinFile: 'app/src/main/java/com/cameronamer/telegramdrive/UploadForegroundService.kt',
    methods: [
      {
        name: 'startService',
        descriptor: '(Landroid/content/Context;)V',
        kotlin: 'fun startService(context: Context)',
        r8: 'void startService(android.content.Context)',
      },
      {
        name: 'stopService',
        descriptor: '(Landroid/content/Context;)V',
        kotlin: 'fun stopService(context: Context)',
        r8: 'void stopService(android.content.Context)',
      },
      {
        name: 'updateService',
        descriptor: '(Landroid/content/Context;IIJZ)V',
        kotlin: 'fun updateService(context: Context, active: Int, percent: Int, speed: Long, isPaused: Boolean)',
        r8: 'void updateService(android.content.Context,int,int,long,boolean)',
      },
    ],
  },
];

const failures = [];

function readRequired(filePath) {
  if (!fs.existsSync(filePath)) {
    failures.push(`Missing required file: ${path.relative(repositoryRoot, filePath)}`);
    return '';
  }
  return fs.readFileSync(filePath, 'utf8');
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const proguardPath = path.join(overridesRoot, 'app', 'proguard-rules.pro');
const proguard = readRequired(proguardPath);
const gradlePath = path.join(overridesRoot, 'app', 'build.gradle.kts');
const gradle = readRequired(gradlePath);
const applyScript = readRequired(path.join(appRoot, 'scripts', 'apply-android-overrides.cjs'));

if (!/getByName\("release"\)/.test(gradle) || !/isMinifyEnabled\s*=\s*true/.test(gradle)) {
  failures.push('Android release builds must keep R8 minification enabled.');
}
if (!/include\("\*\*\/\*\.pro"\)/.test(gradle) || !/proguard-android-optimize\.txt/.test(gradle)) {
  failures.push('Android release builds must include project ProGuard rules and the optimized default rules.');
}
if (!applyScript.includes("'app/proguard-rules.pro'")) {
  failures.push('The Android override copier must verify that proguard-rules.pro was reproduced.');
}

for (const bridge of classes) {
  const kotlinPath = path.join(overridesRoot, bridge.kotlinFile);
  const kotlin = readRequired(kotlinPath);
  const normalizedKotlin = normalizeWhitespace(kotlin);
  const simpleClassName = bridge.className.split('.').at(-1);
  const keptClassPattern = new RegExp(`@Keep\\s+(?:open\\s+)?class\\s+${escapeRegularExpression(simpleClassName)}\\b`);
  if (!keptClassPattern.test(kotlin)) {
    failures.push(`${simpleClassName} must retain its @Keep class annotation.`);
  }

  const proguardClass = escapeRegularExpression(bridge.className);
  const keepRulePattern = new RegExp(`-keep\\s+class\\s+${proguardClass}\\s*\\{\\s*\\*;\\s*\\}`);
  if (!keepRulePattern.test(proguard)) {
    failures.push(`Missing class-wide R8 keep rule for ${bridge.className}.`);
  }

  const rust = bridge.rustFiles
    .map((relative) => readRequired(path.join(appRoot, relative)))
    .join('\n');
  const discovered = new Map();
  const callPattern = new RegExp(
    `call_static_method\\s*\\(\\s*&?${escapeRegularExpression(bridge.rustCallSymbol)}\\s*,\\s*"([^"]+)"\\s*,\\s*"([^"]+)"`,
    'g',
  );
  for (const match of rust.matchAll(callPattern)) {
    discovered.set(`${match[1]}:${match[2]}`, { name: match[1], descriptor: match[2] });
  }

  const expected = new Set(bridge.methods.map((method) => `${method.name}:${method.descriptor}`));
  for (const method of bridge.methods) {
    const key = `${method.name}:${method.descriptor}`;
    if (!discovered.has(key)) {
      failures.push(`Rust JNI contract is missing ${bridge.className}.${method.name}${method.descriptor}.`);
    }
    if (!normalizedKotlin.includes(normalizeWhitespace(`@JvmStatic ${method.kotlin}`))) {
      failures.push(`Kotlin bridge is missing @JvmStatic signature: ${method.kotlin}.`);
    }
  }
  for (const [key, method] of discovered) {
    if (!expected.has(key)) {
      failures.push(
        `Unregistered Rust JNI bridge ${bridge.className}.${method.name}${method.descriptor}; add it to the checked contract.`,
      );
    }
  }
}

const overrideFiles = [
  'app/build.gradle.kts',
  'app/proguard-rules.pro',
  'app/src/main/AndroidManifest.xml',
  'app/src/main/java/com/cameronamer/telegramdrive/MainActivity.kt',
  'app/src/main/java/com/cameronamer/telegramdrive/UploadForegroundService.kt',
  'app/src/main/java/com/cameronamer/telegramdrive/MediaPlayerActivity.kt',
];

if (requireGenerated) {
  for (const relative of overrideFiles) {
    const source = path.join(overridesRoot, relative);
    const generated = path.join(generatedRoot, relative);
    if (!fs.existsSync(generated)) {
      failures.push(`Generated Android input is missing: ${relative}`);
      continue;
    }
    if (!fs.readFileSync(source).equals(fs.readFileSync(generated))) {
      failures.push(`Generated Android input differs from its committed override: ${relative}`);
    }
  }
}

if (r8SeedsPath) {
  const seeds = readRequired(r8SeedsPath);
  for (const bridge of classes) {
    if (!seeds.includes(bridge.className)) {
      failures.push(`R8 seeds do not retain class ${bridge.className}.`);
    }
    for (const method of bridge.methods) {
      const seed = `${bridge.className}: ${method.r8}`;
      if (!seeds.includes(seed)) {
        failures.push(`R8 seeds do not retain JNI method ${seed}.`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error('Android JNI contract check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const checks = [
  `${classes.reduce((total, bridge) => total + bridge.methods.length, 0)} Rust/Kotlin JNI signatures`,
  `${classes.length} class-wide R8 keep rules`,
  'release minification configuration',
];
if (requireGenerated) checks.push('generated-project parity');
if (r8SeedsPath) checks.push('minified-release R8 seeds');
console.log(`Android JNI contract passed: ${checks.join(', ')}.`);
