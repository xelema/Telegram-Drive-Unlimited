package com.cameronamer.telegramdrive

import android.os.Bundle
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.app.ActivityManager
import android.app.UiModeManager
import android.content.pm.ActivityInfo
import android.content.IntentFilter
import android.content.res.Configuration
import android.os.BatteryManager
import android.os.PowerManager
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicBoolean
import android.webkit.MimeTypeMap
import android.provider.OpenableColumns
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.annotation.SuppressLint
import androidx.annotation.Keep
import androidx.activity.enableEdgeToEdge
import androidx.activity.OnBackPressedCallback
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import java.security.KeyStore
import java.lang.ref.WeakReference
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject
import org.json.JSONArray

@Keep
class MainActivity : TauriActivity() {

  companion object {
    private var instanceReference = WeakReference<MainActivity>(null)
    var appContext: Context? = null
    private const val SUPPORTER_KEY_ALIAS = "telegram_drive_supporter_v1"
    private const val SUPPORTER_PREFERENCES = "telegram_drive_supporter_secure_v1"
    private val networkAvailable = AtomicBoolean(false)
    @Volatile private var lastEnvironmentJson = ""
    private val fileCopyExecutor = Executors.newFixedThreadPool(2)
    private const val PRIVACY_PREFERENCES = "telegram_drive_privacy_v1"

    // Thread-safe map from content URI string → pre-cached local file path
    private val uriCacheMap = ConcurrentHashMap<String, String>()
    private val uriCopyLocks = ConcurrentHashMap<String, Any>()

    // Counter for files received via Android share intent, cleared after the frontend reads it.
    // Stored separately from uriCacheMap so file-picker uploads don't trigger share notifications.
    private val shareReceivedCount = AtomicInteger(0)

    @JvmStatic
    fun isNetworkAvailable(): Boolean = networkAvailable.get()

    @JvmStatic
    fun isTelevisionDevice(): Boolean {
      val ctx = appContext ?: return false
      return ctx.getSystemService(UiModeManager::class.java)?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION
    }

    @JvmStatic
    fun getTransferEnvironmentJson(): String {
      val ctx = appContext ?: return "{}"
      val connectivity = ctx.getSystemService(ConnectivityManager::class.java)
      val activeNetwork = connectivity?.activeNetwork
      val capabilities = activeNetwork?.let { connectivity.getNetworkCapabilities(it) }
      val connected = capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true &&
        capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
      val batteryIntent = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
      val status = batteryIntent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
      val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
        status == BatteryManager.BATTERY_STATUS_FULL
      val level = batteryIntent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
      val scale = batteryIntent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
      val batteryPercent = if (level >= 0 && scale > 0) (level * 100 / scale) else 100
      val activityManager = ctx.getSystemService(ActivityManager::class.java)
      val powerManager = ctx.getSystemService(PowerManager::class.java)
      val uiModeManager = ctx.getSystemService(UiModeManager::class.java)
      val freeBytes = ctx.cacheDir.usableSpace.coerceAtLeast(0L)

      return JSONObject().apply {
        put("connected", connected)
        put("metered", connectivity?.isActiveNetworkMetered ?: true)
        put("roaming", Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && connected &&
          capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_ROAMING) == false)
        put("charging", charging)
        put("batteryLow", batteryPercent <= 15)
        put("storageLow", freeBytes < 512L * 1024L * 1024L)
        put("freeBytes", freeBytes)
        put("powerSaveMode", powerManager?.isPowerSaveMode ?: false)
        put("backgroundRestricted", if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) activityManager?.isBackgroundRestricted ?: false else false)
        put("isTelevision", uiModeManager?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION)
      }.toString()
    }

    /**
     * Return a deliberately sanitized support snapshot. It contains no file paths,
     * filenames, account identifiers, message data, tokens, or log contents.
     */
    @Suppress("DEPRECATION")
    @JvmStatic
    fun getSystemDiagnosticsJson(): String {
      val ctx = appContext ?: return "{}"
      val packageInfo = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
      val environment = JSONObject(getTransferEnvironmentJson())
      val exits = JSONArray()
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        try {
          val activityManager = ctx.getSystemService(ActivityManager::class.java)
          activityManager?.getHistoricalProcessExitReasons(ctx.packageName, 0, 5)?.forEach { info ->
            exits.put(JSONObject().apply {
              put("reasonCode", info.reason)
              put("status", info.status)
              put("importance", info.importance)
              put("timestamp", info.timestamp)
            })
          }
        } catch (error: RuntimeException) {
          Log.w("TauriDiagnostics", "Process exit history unavailable: ${error.javaClass.simpleName}")
        }
      }
      return JSONObject().apply {
        put("schemaVersion", 1)
        put("packageName", ctx.packageName)
        put("versionName", packageInfo.versionName ?: "unknown")
        put("versionCode", if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) packageInfo.longVersionCode else packageInfo.versionCode.toLong())
        put("androidApi", Build.VERSION.SDK_INT)
        put("androidRelease", Build.VERSION.RELEASE ?: "unknown")
        put("manufacturer", Build.MANUFACTURER ?: "unknown")
        put("model", Build.MODEL ?: "unknown")
        put("isTelevision", environment.optBoolean("isTelevision", false))
        put("connected", environment.optBoolean("connected", false))
        put("metered", environment.optBoolean("metered", true))
        put("roaming", environment.optBoolean("roaming", false))
        put("charging", environment.optBoolean("charging", false))
        put("batteryLow", environment.optBoolean("batteryLow", false))
        put("storageLow", environment.optBoolean("storageLow", false))
        put("freeBytes", environment.optLong("freeBytes", 0L))
        put("powerSaveMode", environment.optBoolean("powerSaveMode", false))
        put("backgroundRestricted", environment.optBoolean("backgroundRestricted", false))
        put("recentProcessExits", exits)
      }.toString()
    }

    @JvmStatic
    fun configureTransferRecovery(
      wifiOnly: Boolean,
      allowRoaming: Boolean,
      requireCharging: Boolean,
      pauseOnLowBattery: Boolean,
    ) {
      val ctx = appContext ?: return
      TransferRecoveryWorker.configure(ctx, wifiOnly, requireCharging, pauseOnLowBattery)
      ctx.getSharedPreferences("telegram_drive_transfer_recovery_v1", Context.MODE_PRIVATE)
        .edit().putBoolean("allow_roaming", allowRoaming).apply()
    }

    fun requestTransferNotificationPermission() {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
      val activity = currentActivity() ?: return
      if (activity.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == android.content.pm.PackageManager.PERMISSION_GRANTED) return
      Handler(Looper.getMainLooper()).post {
        activity.requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 2026)
      }
    }

    fun emitTransferAction(action: String) {
      if (action !in setOf("pause", "resume", "cancel", "timeout")) return
      appContext?.getSharedPreferences("telegram_drive_transfer_recovery_v1", Context.MODE_PRIVATE)
        ?.edit()?.putString("pending_action", action)?.apply()
      Handler(Looper.getMainLooper()).post {
        val activity = currentActivity() ?: return@post
        val webView = activity.findWebView(activity.findViewById(android.R.id.content)) ?: return@post
        webView.evaluateJavascript(
          "window.dispatchEvent(new CustomEvent('android-transfer-action',{detail:'$action'}))",
          null
        )
        appContext?.getSharedPreferences("telegram_drive_transfer_recovery_v1", Context.MODE_PRIVATE)
          ?.edit()?.remove("pending_action")?.apply()
      }
    }

    private fun emitEnvironmentChanged() {
      val environment = getTransferEnvironmentJson()
      if (environment == lastEnvironmentJson) return
      lastEnvironmentJson = environment
      Handler(Looper.getMainLooper()).post {
        val activity = currentActivity() ?: return@post
        val webView = activity.findWebView(activity.findViewById(android.R.id.content)) ?: return@post
        webView.evaluateJavascript(
          "window.dispatchEvent(new CustomEvent('android-environment-change',{detail:$environment}))",
          null,
        )
      }
    }

    fun emitPlaybackHistoryChanged() {
      Handler(Looper.getMainLooper()).post {
        val activity = currentActivity() ?: return@post
        val webView = activity.findWebView(activity.findViewById(android.R.id.content)) ?: return@post
        webView.evaluateJavascript(
          "window.dispatchEvent(new Event('android-playback-history-change'))",
          null,
        )
      }
    }

    @JvmStatic
    fun getAndClearPendingTransferAction(): String {
      val preferences = appContext
        ?.getSharedPreferences("telegram_drive_transfer_recovery_v1", Context.MODE_PRIVATE)
        ?: return ""
      val action = preferences.getString("pending_action", "") ?: ""
      preferences.edit().remove("pending_action").apply()
      return if (action in setOf("pause", "resume", "cancel", "timeout")) action else ""
    }

    @JvmStatic
    fun isDeviceAuthenticationAvailable(): Boolean {
      val ctx = appContext ?: return false
      val authenticators = BiometricManager.Authenticators.BIOMETRIC_STRONG or
        BiometricManager.Authenticators.DEVICE_CREDENTIAL
      return BiometricManager.from(ctx).canAuthenticate(authenticators) == BiometricManager.BIOMETRIC_SUCCESS
    }

    @JvmStatic
    fun authenticateForSensitiveAction(reason: String): Boolean {
      val activity = currentActivity() ?: return false
      if (!isDeviceAuthenticationAvailable()) return false
      val latch = CountDownLatch(1)
      val authenticated = AtomicBoolean(false)
      Handler(Looper.getMainLooper()).post {
        activity.showDeviceAuthentication(reason) { success ->
          authenticated.set(success)
          latch.countDown()
        }
      }
      return try {
        latch.await(90, TimeUnit.SECONDS) && authenticated.get()
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
        false
      }
    }

    @JvmStatic
    fun configurePrivacy(biometricLock: Boolean, privacyScreen: Boolean, timeoutMinutes: Int): Boolean {
      val ctx = appContext ?: return false
      val authenticationAvailable = isDeviceAuthenticationAvailable()
      ctx.getSharedPreferences(PRIVACY_PREFERENCES, Context.MODE_PRIVATE).edit()
        .putBoolean("biometric_lock", biometricLock && authenticationAvailable)
        .putBoolean("privacy_screen", privacyScreen)
        .putInt("timeout_minutes", timeoutMinutes.coerceIn(0, 240))
        .apply()
      Handler(Looper.getMainLooper()).post {
        currentActivity()?.applyPrivacyScreen(privacyScreen)
      }
      return authenticationAvailable
    }

    private fun supporterPreferenceKey(account: String): String {
      return "credential_${Base64.encodeToString(account.toByteArray(Charsets.UTF_8), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)}"
    }

    private fun supporterKey(): SecretKey {
      val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
      (keyStore.getKey(SUPPORTER_KEY_ALIAS, null) as? SecretKey)?.let { return it }

      fun generate(size: Int): SecretKey {
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        val specification = KeyGenParameterSpec.Builder(
          SUPPORTER_KEY_ALIAS,
          KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .setKeySize(size)
          .setRandomizedEncryptionRequired(true)
          .build()
        generator.init(specification)
        return generator.generateKey()
      }

      return try {
        generate(256)
      } catch (error: Exception) {
        Log.w("TauriSupporter", "AES-256 Keystore key unavailable; using AES-128: ${error.javaClass.simpleName}")
        generate(128)
      }
    }

    /** Encrypt a supporter credential with a non-exportable Android Keystore key. */
    @SuppressLint("ApplySharedPref") // JNI reports success only after durable persistence.
    @JvmStatic
    fun putSupporterSecret(account: String, value: String): Boolean {
      val ctx = appContext ?: return false
      if (account.isBlank() || value.isEmpty()) return false
      return try {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, supporterKey())
        val ciphertext = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        val payload = ByteArray(1 + cipher.iv.size + ciphertext.size)
        payload[0] = cipher.iv.size.toByte()
        cipher.iv.copyInto(payload, 1)
        ciphertext.copyInto(payload, 1 + cipher.iv.size)
        ctx.getSharedPreferences(SUPPORTER_PREFERENCES, Context.MODE_PRIVATE)
          .edit()
          .putString(supporterPreferenceKey(account), Base64.encodeToString(payload, Base64.NO_WRAP))
          .commit()
      } catch (error: Exception) {
        Log.e("TauriSupporter", "Unable to save encrypted supporter credential: ${error.javaClass.simpleName}")
        false
      }
    }

    /** Return a decrypted credential, or an empty value when none is available. */
    @SuppressLint("ApplySharedPref") // Corrupt hardware-bound data must be removed synchronously.
    @JvmStatic
    fun getSupporterSecret(account: String): String {
      val ctx = appContext ?: return ""
      val preferences = ctx.getSharedPreferences(SUPPORTER_PREFERENCES, Context.MODE_PRIVATE)
      val preferenceKey = supporterPreferenceKey(account)
      val encoded = preferences.getString(preferenceKey, null) ?: return ""
      return try {
        val payload = Base64.decode(encoded, Base64.NO_WRAP)
        if (payload.size < 14) throw IllegalArgumentException("Encrypted credential is truncated")
        val nonceLength = payload[0].toInt() and 0xff
        if (nonceLength !in 12..16 || payload.size <= 1 + nonceLength) {
          throw IllegalArgumentException("Encrypted credential has an invalid nonce")
        }
        val nonce = payload.copyOfRange(1, 1 + nonceLength)
        val ciphertext = payload.copyOfRange(1 + nonceLength, payload.size)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, supporterKey(), GCMParameterSpec(128, nonce))
        String(cipher.doFinal(ciphertext), Charsets.UTF_8)
      } catch (error: Exception) {
        // A restored preference cannot be decrypted without its original hardware key.
        // Remove only the unusable entry; the recovery code can reactivate the license.
        preferences.edit().remove(preferenceKey).commit()
        Log.w("TauriSupporter", "Discarded an unreadable supporter credential: ${error.javaClass.simpleName}")
        ""
      }
    }

    @SuppressLint("ApplySharedPref") // JNI reports completion only after the delete is durable.
    @JvmStatic
    fun deleteSupporterSecret(account: String): Boolean {
      val ctx = appContext ?: return false
      return ctx.getSharedPreferences(SUPPORTER_PREFERENCES, Context.MODE_PRIVATE)
        .edit()
        .remove(supporterPreferenceKey(account))
        .commit()
    }

    private fun currentActivity(): MainActivity? = instanceReference.get()

    /**
     * Called from Rust JNI background thread to check for files shared into the app
     * while the webview was not yet ready (cold start). Returns the count and resets it.
     */
    @JvmStatic
    fun getAndClearShareCount(): Int {
      return shareReceivedCount.getAndSet(0)
    }

    /**
     * Called from Rust JNI background thread to look up a pre-cached file path for a URI.
     * Returns the local cached path if available, or empty string if not pre-cached.
     */
    @JvmStatic
    fun getCachedPath(uriString: String): String {
      val direct = uriCacheMap[uriString]
      if (direct != null && direct.isNotEmpty()) return direct

      // Try decoded version of the search string
      val decodedSearch = Uri.decode(uriString)
      val fromDecoded = uriCacheMap[decodedSearch]
      if (fromDecoded != null && fromDecoded.isNotEmpty()) return fromDecoded

      // Iterate and compare all keys dynamically in URL-decoded format
      for ((key, value) in uriCacheMap) {
        if (Uri.decode(key) == decodedSearch || Uri.decode(key) == uriString || key == decodedSearch) {
          return value
        }
      }
      return ""
    }

    /**
     * Return a JSON array of all cached file entries for the frontend to display.
     * Each entry: { uri, cachedPath, fileName, fileSize }
     */
    @JvmStatic
    fun listCachedFiles(): String {
      val sb = StringBuilder()
      sb.append("[")
      var first = true
      for ((uri, cachedPath) in uriCacheMap) {
        if (!first) sb.append(",")
        first = false
        val file = File(cachedPath)
        val fileName = file.name
        val fileSize = if (file.exists()) file.length() else 0L
        // Manual JSON escaping for URI, path, and filename
        fun escape(s: String): String = s
          .replace("\\", "\\\\")
          .replace("\"", "\\\"")
          .replace("\n", "\\n")
          .replace("\r", "\\r")
          .replace("\t", "\\t")
        sb.append("{\"uri\":\"").append(escape(uri))
        sb.append("\",\"cachedPath\":\"").append(escape(cachedPath))
        sb.append("\",\"fileName\":\"").append(escape(fileName))
        sb.append("\",\"fileSize\":").append(fileSize).append("}")
      }
      sb.append("]")
      Log.i("TauriUpload", "listCachedFiles: ${uriCacheMap.size} entries")
      return sb.toString()
    }

    /**
     * Remove a cached entry and delete the physical cache file from disk.
     */
    @JvmStatic
    fun removeCachedPath(uriString: String) {
      // Delete the actual cached file from disk before removing the map entry
      val cachedPath = uriCacheMap[uriString]
      if (cachedPath != null) {
        try {
          val file = File(cachedPath)
          if (file.exists()) {
            val deleted = file.delete()
            if (deleted) {
              Log.i("TauriUpload", "Deleted cached file: $cachedPath")
            } else {
              Log.w("TauriUpload", "Failed to delete cached file: $cachedPath")
            }
          }
        } catch (e: Exception) {
          Log.w("TauriUpload", "Error deleting cached file $cachedPath: ${e.message}")
        }
      }
      uriCacheMap.remove(uriString)
      val decoded = Uri.decode(uriString)
      uriCacheMap.remove(decoded)
      val keysToRemove = mutableListOf<String>()
      for (key in uriCacheMap.keys) {
        if (Uri.decode(key) == decoded || key == decoded) {
          keysToRemove.add(key)
        }
      }
      for (key in keysToRemove) {
        uriCacheMap.remove(key)
      }
    }

    @JvmStatic
    fun getUniqueSanitizedFileName(ctx: Context, uri: Uri): String {
      var displayName = ""
      try {
        ctx.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
          val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          if (nameIndex != -1 && cursor.moveToFirst()) {
            displayName = cursor.getString(nameIndex) ?: ""
          }
        }
      } catch (e: Exception) {
        Log.w("TauriUpload", "Failed to query display name for $uri: ${e.message}")
      }

      displayName = displayName.trim()
        .replace("[\\\\/:*?\"<>|]".toRegex(), "_")
        .replace("\\s+".toRegex(), "_")

      if (displayName.isEmpty() || !displayName.contains(".")) {
        var ext = ""
        try {
          val mime = ctx.contentResolver.getType(uri)
          if (mime != null) {
            if (mime == "application/pdf") {
              ext = "pdf"
            } else {
              ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime) ?: ""
            }
          }
        } catch (e: Exception) {
          Log.w("TauriUpload", "Failed to query MIME type: ${e.message}")
        }
        if (ext.isEmpty()) ext = "bin"

        val base = if (displayName.isEmpty()) "upload_${System.currentTimeMillis()}" else displayName
        displayName = "$base.$ext"
      }

      var finalFile = File(ctx.cacheDir, displayName)
      if (finalFile.exists()) {
        val dotIdx = displayName.lastIndexOf('.')
        val baseName = if (dotIdx != -1) displayName.substring(0, dotIdx) else displayName
        val ext = if (dotIdx != -1) displayName.substring(dotIdx) else ""
        var counter = 1
        while (finalFile.exists()) {
          finalFile = File(ctx.cacheDir, "${baseName}_$counter$ext")
          counter++
        }
      }

      return finalFile.name
    }

    private fun copyInputToFile(inputStream: InputStream, targetFile: File): Long {
      var copiedBytes = 0L
      FileOutputStream(targetFile).use { outputStream ->
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        while (true) {
          val read = inputStream.read(buffer)
          if (read == -1) break
          outputStream.write(buffer, 0, read)
          copiedBytes += read.toLong()
        }
        outputStream.flush()
        try {
          outputStream.fd.sync()
        } catch (e: Exception) {
          Log.w("TauriFileCopy", "FileDescriptor sync failed for ${targetFile.absolutePath}: ${e.message}")
        }
      }
      return copiedBytes
    }

    private fun copyCacheFileToOutput(cacheFile: File, outputStream: OutputStream): Long {
      var copiedBytes = 0L
      cacheFile.inputStream().use { inputStream ->
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        while (true) {
          val read = inputStream.read(buffer)
          if (read == -1) break
          outputStream.write(buffer, 0, read)
          copiedBytes += read.toLong()
        }
      }
      outputStream.flush()
      return copiedBytes
    }

    private fun sanitizePublicDownloadName(fileName: String): String {
      val leaf = fileName.substringAfterLast('/').substringAfterLast('\\')
      val cleaned = leaf.map { character ->
        if (character.code < 32 || character.code == 127 || character in charArrayOf('<', '>', ':', '"', '/', '\\', '|', '?', '*')) {
          '_'
        } else {
          character
        }
      }.joinToString("").trim().trim('.')
      return cleaned.ifBlank { "download.bin" }
    }

    private data class PublishedDownloadMetadata(
      val displayName: String?,
      val size: Long?
    )

    private fun queryPublishedDownloadMetadata(
      resolver: android.content.ContentResolver,
      uri: Uri
    ): PublishedDownloadMetadata? {
      return try {
        resolver.query(
          uri,
          arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
          null,
          null,
          null
        )?.use { cursor ->
          if (!cursor.moveToFirst()) return@use null
          val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
          PublishedDownloadMetadata(
            if (nameIndex >= 0 && !cursor.isNull(nameIndex)) cursor.getString(nameIndex) else null,
            if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) cursor.getLong(sizeIndex) else null
          )
        }
      } catch (e: Exception) {
        Log.w("TauriDownload", "Unable to query published metadata for $uri: ${e.message}")
        null
      }
    }

    private fun insertPendingDownload(
      resolver: android.content.ContentResolver,
      downloadsUri: Uri,
      safeFileName: String,
      mimeType: String,
      expectedBytes: Long
    ): Uri? {
      // GrapheneOS and some OEM file managers rely on the indexed SIZE value.
      // Try an explicit value first, then retry with Android's stock minimal
      // columns for providers that reject caller-supplied SIZE metadata.
      val enrichedValues = android.content.ContentValues().apply {
        put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, safeFileName)
        put(android.provider.MediaStore.MediaColumns.MIME_TYPE, mimeType)
        put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, android.os.Environment.DIRECTORY_DOWNLOADS)
        put(android.provider.MediaStore.MediaColumns.SIZE, expectedBytes)
        put(android.provider.MediaStore.MediaColumns.IS_PENDING, 1)
      }
      try {
        resolver.insert(downloadsUri, enrichedValues)?.let { return it }
      } catch (e: Exception) {
        Log.w("TauriDownload", "MediaStore rejected explicit size metadata; retrying stock insert: ${e.message}")
      }

      val stockValues = android.content.ContentValues().apply {
        put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, safeFileName)
        put(android.provider.MediaStore.MediaColumns.MIME_TYPE, mimeType)
        put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, android.os.Environment.DIRECTORY_DOWNLOADS)
        put(android.provider.MediaStore.MediaColumns.IS_PENDING, 1)
      }
      return try {
        resolver.insert(downloadsUri, stockValues)
      } catch (e: Exception) {
        Log.e("TauriDownload", "Stock MediaStore insert failed: ${e.message}", e)
        null
      }
    }

    @JvmStatic
    fun saveFileToPublicDownloads(cachePath: String, fileName: String, mimeType: String): Boolean {
      val ctx = appContext ?: return false
      var insertedUri: Uri? = null
      try {
        val cacheFile = File(cachePath)
        if (!cacheFile.exists()) {
          Log.e("TauriDownload", "Cache file does not exist: $cachePath")
          return false
        }
        if (!cacheFile.isFile || cacheFile.length() <= 0L) {
          Log.e("TauriDownload", "Cache file is empty or invalid: $cachePath (${cacheFile.length()} bytes)")
          return false
        }

        val safeFileName = sanitizePublicDownloadName(fileName)
        val expectedBytes = cacheFile.length()
        val resolver = ctx.contentResolver

        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.Q) {
          // Legacy storage direct file writing (Android < 10)
          val publicDownloadsDir = android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS)
          if (!publicDownloadsDir.exists()) {
            publicDownloadsDir.mkdirs()
          }
          var targetFile = File(publicDownloadsDir, safeFileName)
          if (targetFile.exists()) {
            val dotIdx = safeFileName.lastIndexOf('.')
            val baseName = if (dotIdx != -1) safeFileName.substring(0, dotIdx) else safeFileName
            val ext = if (dotIdx != -1) safeFileName.substring(dotIdx) else ""
            var counter = 1
            while (targetFile.exists()) {
              targetFile = File(publicDownloadsDir, "${baseName}_$counter$ext")
              counter++
            }
          }

          val copiedBytes = FileOutputStream(targetFile).use { outStream ->
            val bytes = copyCacheFileToOutput(cacheFile, outStream)
            try {
              outStream.fd.sync()
            } catch (e: Exception) {
              Log.w("TauriDownload", "Pre-Q FileDescriptor sync failed: ${e.message}")
            }
            bytes
          }

          if (copiedBytes != expectedBytes || targetFile.length() != expectedBytes) {
            Log.e("TauriDownload", "Pre-Q copy size mismatch. expected=$expectedBytes copied=$copiedBytes target=${targetFile.length()}")
            targetFile.delete()
            return false
          }

          android.media.MediaScannerConnection.scanFile(
            ctx,
            arrayOf(targetFile.absolutePath),
            arrayOf(mimeType),
            null,
          )

          Log.i("TauriDownload", "Pre-Q direct save completed: ${targetFile.absolutePath} (${targetFile.length()} bytes)")
          return true
        } else {
          // Android Q+ (Scoped Storage with MediaStore)
          val downloadsUri = android.provider.MediaStore.Downloads.getContentUri(
            android.provider.MediaStore.VOLUME_EXTERNAL_PRIMARY
          )
          val uri = insertPendingDownload(
            resolver,
            downloadsUri,
            safeFileName,
            mimeType,
            expectedBytes
          ) ?: run {
            Log.e("TauriDownload", "MediaStore insert returned null for $safeFileName")
            return false
          }
          insertedUri = uri

          val pfd = resolver.openFileDescriptor(uri, "w") ?: run {
            Log.e("TauriDownload", "MediaStore openFileDescriptor returned null for $uri")
            resolver.delete(uri, null, null)
            return false
          }
          val copiedBytes = try {
            FileOutputStream(pfd.fileDescriptor).use { outStream ->
              val bytes = copyCacheFileToOutput(cacheFile, outStream)
              outStream.flush()
              try {
                outStream.fd.sync()
              } catch (e: Exception) {
                Log.w("TauriDownload", "FileDescriptor sync failed: ${e.message}")
              }
              bytes
            }
          } catch (e: Exception) {
            Log.e("TauriDownload", "Failed to write to MediaStore stream: ${e.message}")
            try { pfd.close() } catch (ex: Exception) {}
            resolver.delete(uri, null, null)
            return false
          } finally {
            try { pfd.close() } catch (ex: Exception) {}
          }

          if (copiedBytes != expectedBytes) {
            Log.e("TauriDownload", "Q+ copy size mismatch. expected=$expectedBytes copied=$copiedBytes uri=$uri")
            resolver.delete(uri, null, null)
            return false
          }

          // Publish with explicit metadata. Some OEM providers expose stale
          // DISPLAY_NAME/SIZE values unless they are repeated in the final update.
          val publishValues = android.content.ContentValues().apply {
            put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, safeFileName)
            put(android.provider.MediaStore.MediaColumns.MIME_TYPE, mimeType)
            put(android.provider.MediaStore.MediaColumns.SIZE, expectedBytes)
            put(android.provider.MediaStore.MediaColumns.IS_PENDING, 0)
          }
          val published = try {
            resolver.update(uri, publishValues, null, null) > 0
          } catch (e: Exception) {
            Log.w("TauriDownload", "MediaStore rejected enriched publish metadata; retrying stock publish: ${e.message}")
            false
          }
          if (!published) {
            val stockPublishValues = android.content.ContentValues().apply {
              put(android.provider.MediaStore.MediaColumns.IS_PENDING, 0)
            }
            try {
              if (resolver.update(uri, stockPublishValues, null, null) <= 0) {
                Log.e("TauriDownload", "MediaStore did not publish pending item $uri")
                resolver.delete(uri, null, null)
                return false
              }
            } catch (e: Exception) {
              Log.e("TauriDownload", "Stock MediaStore publish failed: ${e.message}", e)
              resolver.delete(uri, null, null)
              return false
            }
          }

          val indexed = queryPublishedDownloadMetadata(resolver, uri)
          if (indexed?.size != expectedBytes || indexed.displayName.isNullOrBlank()) {
            Log.w(
              "TauriDownload",
              "Published metadata needs repair: requestedName=$safeFileName indexedName=${indexed?.displayName} expectedSize=$expectedBytes indexedSize=${indexed?.size}"
            )
            val repairValues = android.content.ContentValues().apply {
              put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, safeFileName)
              put(android.provider.MediaStore.MediaColumns.MIME_TYPE, mimeType)
              put(android.provider.MediaStore.MediaColumns.SIZE, expectedBytes)
            }
            try {
              resolver.update(uri, repairValues, null, null)
            } catch (e: Exception) {
              // The file is already safely published. Keep the stock-provider
              // result rather than discarding valid bytes on a restrictive OEM.
              Log.w("TauriDownload", "MediaStore metadata repair unsupported: ${e.message}")
            }
          }

          val verified = queryPublishedDownloadMetadata(resolver, uri)
          Log.i(
            "TauriDownload",
            "Q+ MediaStore save completed: $uri ($copiedBytes bytes, indexedName=${verified?.displayName}, indexedSize=${verified?.size})"
          )
          return true
        }
      } catch (e: Exception) {
        Log.e("TauriDownload", "Error saving file to public downloads: ${e.message}", e)
        insertedUri?.let {
          try {
            ctx.contentResolver.delete(it, null, null)
          } catch (deleteError: Exception) {
            Log.w("TauriDownload", "Failed to delete incomplete MediaStore item $it: ${deleteError.message}")
          }
        }
        return false
      }
    }

    @JvmStatic
    fun openFileExternally(cachePath: String, mimeType: String): Boolean {
      val ctx = appContext ?: return false
      try {
        val file = File(cachePath).canonicalFile
        val cacheRoot = ctx.cacheDir.canonicalFile
        if (file.path != cacheRoot.path && !file.path.startsWith(cacheRoot.path + File.separator)) {
          Log.e("TauriOpen", "Refusing to expose a file outside the application cache")
          return false
        }
        if (!file.exists()) {
          Log.e("TauriOpen", "File to open does not exist: $cachePath")
          return false
        }
        val authority = "${ctx.packageName}.fileprovider"
        val uri = androidx.core.content.FileProvider.getUriForFile(ctx, authority, file)
        val intent = Intent(Intent.ACTION_VIEW).apply {
          setDataAndType(uri, mimeType)
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        ctx.startActivity(intent)
        Log.i("TauriOpen", "Successfully launched Intent for file: $cachePath")
        return true
      } catch (e: Exception) {
        Log.e("TauriOpen", "Failed to open file externally: ${e.message}", e)
        return false
      }
    }

    /** Launch Android's trusted package installer for a hash-verified APK. */
    @JvmStatic
    fun installVerifiedApk(cachePath: String): Int {
      val ctx = appContext ?: return 0
      return try {
        val file = File(cachePath).canonicalFile
        val updateRoot = File(ctx.cacheDir, "updates").canonicalFile
        if (!file.name.endsWith(".apk", ignoreCase = true) ||
          (file.path != updateRoot.path && !file.path.startsWith(updateRoot.path + File.separator))) {
          Log.e("TauriUpdate", "Refusing to install an APK outside the verified update cache")
          return 0
        }
        if (!file.isFile || file.length() <= 0L) return 0

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
          !ctx.packageManager.canRequestPackageInstalls()) {
          val settingsIntent = Intent(
            android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:${ctx.packageName}")
          ).apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
          ctx.startActivity(settingsIntent)
          return 2
        }

        val uri = androidx.core.content.FileProvider.getUriForFile(
          ctx,
          "${ctx.packageName}.fileprovider",
          file
        )
        val intent = Intent(Intent.ACTION_VIEW).apply {
          setDataAndType(uri, "application/vnd.android.package-archive")
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        ctx.startActivity(intent)
        1
      } catch (error: Exception) {
        Log.e("TauriUpdate", "Failed to launch the package installer: ${error.message}", error)
        0
      }
    }

    @Suppress("DEPRECATION")
    @JvmStatic
    fun getInstalledVersionCode(): Long {
      val ctx = appContext ?: return 0L
      val packageInfo = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
      return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        packageInfo.longVersionCode
      } else {
        packageInfo.versionCode.toLong()
      }
    }

    /** Open an authenticated localhost stream in Telegram Drive's native player. */
    @JvmStatic
    fun openMediaStream(streamUrl: String, title: String, mimeType: String, mediaId: String, preferences: String): Boolean {
      val ctx = appContext ?: return false
      if (!streamUrl.startsWith("http://localhost:")) return false
      return try {
        val intent = Intent(ctx, MediaPlayerActivity::class.java).apply {
          putExtra(MediaPlayerActivity.EXTRA_STREAM_URL, streamUrl)
          putExtra(MediaPlayerActivity.EXTRA_TITLE, title)
          putExtra(MediaPlayerActivity.EXTRA_MIME_TYPE, mimeType)
          putExtra(MediaPlayerActivity.EXTRA_MEDIA_ID, mediaId)
          putExtra(MediaPlayerActivity.EXTRA_PREFERENCES, preferences)
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        ctx.startActivity(intent)
        true
      } catch (error: Exception) {
        Log.e("TauriMedia", "Failed to launch the in-app player: ${error.message}", error)
        false
      }
    }

    @JvmStatic
    fun getPlaybackHistory(): String {
      val ctx = appContext ?: return "[]"
      return PlaybackService.getPlaybackHistoryJson(ctx)
    }

    /** Copy a content URI on the calling worker thread; never invoke on the UI thread. */
    @JvmStatic
    fun getLocalFileFromUri(uriString: String): String {
      val ctx = appContext ?: return ""
      var targetUriString = uriString
      if (!targetUriString.startsWith("content://")) {
        var cleanMsf = targetUriString
        if (cleanMsf.startsWith("/")) {
          cleanMsf = cleanMsf.substring(1)
        }
        if (cleanMsf.startsWith("msf:") || cleanMsf.startsWith("msf%3A")) {
          val id = cleanMsf.substring(4).replace("%3A", "").replace(":", "")
          targetUriString = "content://com.android.providers.media.documents/document/msf%3A$id"
        }
      }
      val uri = Uri.parse(targetUriString)
      getCachedPath(uriString).takeIf { it.isNotEmpty() }?.let { return it }
      return copyUriToCache(ctx, uri, uriString)
    }

    private fun copyUriToCache(ctx: Context, uri: Uri, cacheKey: String): String {
      val lock = uriCopyLocks.computeIfAbsent(cacheKey) { Any() }
      return synchronized(lock) {
        try {
          uriCacheMap[cacheKey]?.takeIf { File(it).isFile }?.let { return@synchronized it }
          val fileName = getUniqueSanitizedFileName(ctx, uri)
          val tempFile = File(ctx.cacheDir, fileName)
          val copiedBytes = ctx.contentResolver.openInputStream(uri)?.use { copyInputToFile(it, tempFile) } ?: 0L
          if (copiedBytes > 0L && tempFile.length() == copiedBytes) {
            uriCacheMap[cacheKey] = tempFile.absolutePath
            Log.i("TauriUpload", "Cached URI on a worker thread: $uri -> ${tempFile.absolutePath} ($copiedBytes bytes)")
            tempFile.absolutePath
          } else {
            tempFile.delete()
            Log.e("TauriUpload", "URI cache copy was empty or incomplete: $uri")
            ""
          }
        } catch (error: Exception) {
          Log.e("TauriUpload", "Worker URI copy failed for $uri: ${error.message}", error)
          ""
        } finally {
          uriCopyLocks.remove(cacheKey, lock)
        }
      }
    }
  }

  private var connectivityManager: ConnectivityManager? = null
  private var lockOverlay: View? = null
  private var lockPromptOpen = false
  private val networkCallback = object : ConnectivityManager.NetworkCallback() {
    override fun onAvailable(network: Network) = refreshNetworkAvailability()
    override fun onLost(network: Network) = refreshNetworkAvailability()
    override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) = refreshNetworkAvailability()
    override fun onUnavailable() = refreshNetworkAvailability()
  }

  private fun refreshNetworkAvailability() {
    val manager = connectivityManager ?: return
    val active = manager.activeNetwork
    val capabilities = active?.let { manager.getNetworkCapabilities(it) }
    networkAvailable.set(
      capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true &&
        capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    )
    emitEnvironmentChanged()
  }

  private fun showDeviceAuthentication(reason: String, result: (Boolean) -> Unit) {
    val authenticators = BiometricManager.Authenticators.BIOMETRIC_STRONG or
      BiometricManager.Authenticators.DEVICE_CREDENTIAL
    val prompt = BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
      override fun onAuthenticationSucceeded(value: BiometricPrompt.AuthenticationResult) = result(true)
      override fun onAuthenticationError(errorCode: Int, errString: CharSequence) = result(false)
      override fun onAuthenticationFailed() {
        // Keep the system prompt open; a later success/error produces the final result.
      }
    })
    prompt.authenticate(
      BiometricPrompt.PromptInfo.Builder()
        .setTitle("Unlock Telegram Drive")
        .setSubtitle(reason.take(100))
        .setAllowedAuthenticators(authenticators)
        .build(),
    )
  }

  private fun applyPrivacyScreen(enabled: Boolean) {
    if (enabled) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
  }

  private fun enforceAppLockIfNeeded() {
    val preferences = getSharedPreferences(PRIVACY_PREFERENCES, Context.MODE_PRIVATE)
    applyPrivacyScreen(preferences.getBoolean("privacy_screen", false))
    if (!preferences.getBoolean("biometric_lock", false) || lockPromptOpen) return
    val backgroundAt = preferences.getLong("background_at", 0L)
    if (backgroundAt <= 0L) return
    val timeout = preferences.getInt("timeout_minutes", 5).coerceIn(0, 240)
    if (System.currentTimeMillis() - backgroundAt < timeout * 60_000L) return

    val overlay = FrameLayout(this).apply {
      setBackgroundColor(android.graphics.Color.BLACK)
      isClickable = true
      isFocusable = true
      addView(TextView(this@MainActivity).apply {
        text = "Telegram Drive is locked"
        setTextColor(android.graphics.Color.WHITE)
        textSize = 18f
        gravity = Gravity.CENTER
      }, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    }
    addContentView(overlay, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    lockOverlay = overlay
    lockPromptOpen = true
    showDeviceAuthentication("Authenticate to return to your files") { success ->
      lockPromptOpen = false
      if (success) {
        preferences.edit().putLong("background_at", 0L).apply()
        (lockOverlay?.parent as? android.view.ViewGroup)?.removeView(lockOverlay)
        lockOverlay = null
      } else {
        moveTaskToBack(true)
      }
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    try {
      System.loadLibrary("c++_shared")
      Log.i("TauriNative", "Loaded libc++_shared before Rust library initialization")
    } catch (e: UnsatisfiedLinkError) {
      Log.w("TauriNative", "Unable to preload libc++_shared: ${e.message}")
    }
    super.onCreate(savedInstanceState)
    instanceReference = WeakReference(this)
    MainActivity.appContext = applicationContext
    if (isTelevisionDevice()) requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
    connectivityManager = getSystemService(ConnectivityManager::class.java)
    refreshNetworkAvailability()
    try {
      connectivityManager?.registerDefaultNetworkCallback(networkCallback)
    } catch (error: Exception) {
      Log.w("TauriNetwork", "Unable to register Android network callback: ${error.javaClass.simpleName}")
    }

    // Handle share intent from cold start (ACTION_SEND)
    handleShareIntent(intent)

    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val webView = findWebView(findViewById(android.R.id.content))
        if (webView == null) {
          finish()
          return
        }
        webView.evaluateJavascript("window.__telegramDriveHandleAndroidBack?.() === true") { handled ->
          if (handled != "true") {
            isEnabled = false
            onBackPressedDispatcher.onBackPressed()
            isEnabled = true
          }
        }
      }
    })

    // Do not request permissions during startup. Android file access is handled
    // through user-granted content URIs and MediaStore publication, while asking
    // for runtime permissions inside onCreate can interrupt Wry/Tauri startup.
  }

  override fun onDestroy() {
    try {
      connectivityManager?.unregisterNetworkCallback(networkCallback)
    } catch (_: Exception) {
      // The callback may not have registered on a restricted Android variant.
    }
    if (instanceReference.get() === this) instanceReference.clear()
    super.onDestroy()
  }

  override fun onStart() {
    super.onStart()
    disableWebViewSaveEnabled(findViewById(android.R.id.content))
    enforceAppLockIfNeeded()
  }

  override fun onStop() {
    if (!isChangingConfigurations) {
      getSharedPreferences(PRIVACY_PREFERENCES, Context.MODE_PRIVATE).edit()
        .putLong("background_at", System.currentTimeMillis()).apply()
    }
    super.onStop()
  }

  /**
   * Handle new intents while the app is already running.
   * Called for both deep links (via tauri-plugin-deep-link) and share intents (ACTION_SEND).
   */
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    // super.onNewIntent() forwards deep links to the Tauri deep-link plugin automatically.
    // We additionally handle share intents here.
    handleShareIntent(intent)
  }

  /**
   * Process ACTION_SEND / ACTION_SEND_MULTIPLE intents: copy shared files to
   * the app's cache directory and register them in uriCacheMap so the Rust
   * upload pipeline can access them.
   */
  private fun handleShareIntent(intent: Intent?) {
    if (intent == null) return
    val action = intent.action ?: return
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return

    Log.i("TauriShare", "Received share intent: $action")

    val uris = mutableListOf<Uri>()
    if (action == Intent.ACTION_SEND) {
      // Single item share
      getSharedStreamUri(intent)?.let { uris.add(it) }
    } else {
      // Multiple items share
      uris.addAll(getSharedStreamUris(intent))
    }

    if (uris.isEmpty()) {
      Log.w("TauriShare", "Share intent contained no URIs")
      return
    }

    Log.i("TauriShare", "Processing ${uris.size} shared URI(s)")
    val completed = AtomicInteger(0)
    val cachedCount = AtomicInteger(0)
    for (uri in uris) {
      try {
        // Take a read permission grant while we can (best-effort)
        try {
          contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (e: SecurityException) {
          Log.w("TauriShare", "Could not take persistable permission for $uri: ${e.message}")
        }

        fileCopyExecutor.execute {
          if (cacheUriToLocalFile(uri)) cachedCount.incrementAndGet()
          if (completed.incrementAndGet() == uris.size) {
            notifySharedFilesCached(cachedCount.get())
          }
        }
      } catch (e: Exception) {
        Log.e("TauriShare", "Failed to process shared URI $uri: ${e.message}")
      }
    }

  }

  private fun notifySharedFilesCached(count: Int) {
    if (count <= 0) return
    shareReceivedCount.addAndGet(count)
    runOnUiThread {
      try {
        val webView = findWebView(findViewById(android.R.id.content))
        webView?.evaluateJavascript(
          "window.__TAURI_INTERNALS__.emit('share-received', {\"count\":$count})",
          null
        )
      } catch (error: Exception) {
        Log.w("TauriShare", "Could not emit share-received event: ${error.message}")
      }
    }
  }

  @Suppress("DEPRECATION")
  private fun getSharedStreamUri(intent: Intent): Uri? {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    } else {
      intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri
    }
  }

  @Suppress("DEPRECATION")
  private fun getSharedStreamUris(intent: Intent): ArrayList<Uri> {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java) ?: arrayListOf()
    } else {
      intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM) ?: arrayListOf()
    }
  }

  private fun disableWebViewSaveEnabled(view: android.view.View) {
    if (view is android.webkit.WebView) {
      view.isSaveEnabled = false
      Log.i("TauriWebView", "Successfully set isSaveEnabled = false on WebView!")
    } else if (view is android.view.ViewGroup) {
      for (i in 0 until view.childCount) {
        disableWebViewSaveEnabled(view.getChildAt(i))
      }
    }
  }

  private fun findWebView(view: android.view.View): android.webkit.WebView? {
    if (view is android.webkit.WebView) {
      return view
    } else if (view is android.view.ViewGroup) {
      for (i in 0 until view.childCount) {
        val wv = findWebView(view.getChildAt(i))
        if (wv != null) return wv
      }
    }
    return null
  }

  @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    if (resultCode == RESULT_OK && data != null) {
      val flags = data.flags
      val isPersistable = (flags and Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) != 0

      // Collect all URIs from single or multi-select
      val uris = mutableListOf<Uri>()
      data.data?.let { uris.add(it) }
      data.clipData?.let { clip ->
        for (i in 0 until clip.itemCount) {
          clip.getItemAt(i).uri?.let { uris.add(it) }
        }
      }

      for (uri in uris) {
        // 1. Try to take persistable permission (best-effort, only works for ACTION_OPEN_DOCUMENT)
        if (isPersistable) {
          try {
            contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            Log.i("TauriUpload", "Took persistable permission for: $uri")
          } catch (e: SecurityException) {
            Log.w("TauriUpload", "SecurityException taking persistable permission: ${e.message}")
          } catch (e: Exception) {
            Log.w("TauriUpload", "Exception taking persistable permission: ${e.message}")
          }
        }

        // Copy provider bytes away from the UI thread. The Rust fallback can
        // independently stage the URI if the uploader reaches it first.
        fileCopyExecutor.execute { cacheUriToLocalFile(uri) }
      }
    }
  }

  private fun cacheUriToLocalFile(uri: Uri): Boolean {
    return copyUriToCache(applicationContext, uri, uri.toString()).isNotEmpty()
  }
}
