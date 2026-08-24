package com.cameronamer.telegramdrive

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.annotation.Keep
import androidx.core.app.NotificationCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

@Keep
class TransferRecoveryWorker(
  appContext: Context,
  params: WorkerParameters,
) : CoroutineWorker(appContext, params) {
  override suspend fun doWork(): Result {
    if (!hasPendingTransfers(applicationContext)) return Result.success()
    createChannel(applicationContext)
    val openApp = PendingIntent.getActivity(
      applicationContext,
      0,
      Intent(applicationContext, MainActivity::class.java).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        putExtra("open_transfers", true)
      },
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val notification = NotificationCompat.Builder(applicationContext, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_sys_warning)
      .setContentTitle("Resume Telegram Drive transfers")
      .setContentText("A saved upload or download is waiting. Open the app to continue safely.")
      .setContentIntent(openApp)
      .setAutoCancel(true)
      .setCategory(NotificationCompat.CATEGORY_REMINDER)
      .build()
    applicationContext.getSystemService(NotificationManager::class.java)
      ?.notify(NOTIFICATION_ID, notification)
    return Result.success()
  }

  companion object {
    private const val PREFS = "telegram_drive_transfer_recovery_v1"
    private const val PENDING = "pending"
    private const val WIFI_ONLY = "wifi_only"
    private const val REQUIRE_CHARGING = "require_charging"
    private const val PAUSE_LOW_BATTERY = "pause_low_battery"
    private const val WORK_NAME = "telegram-drive-transfer-recovery"
    private const val CHANNEL_ID = "TransferRecoveryChannel"
    private const val NOTIFICATION_ID = 2027

    fun setPendingTransfers(context: Context, pending: Boolean) {
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        .edit().putBoolean(PENDING, pending).apply()
      if (!pending) {
        WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME)
        context.getSystemService(NotificationManager::class.java)?.cancel(NOTIFICATION_ID)
      }
    }

    fun hasPendingTransfers(context: Context): Boolean =
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(PENDING, false)

    fun configure(
      context: Context,
      wifiOnly: Boolean,
      requireCharging: Boolean,
      pauseOnLowBattery: Boolean,
    ) {
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
        .putBoolean(WIFI_ONLY, wifiOnly)
        .putBoolean(REQUIRE_CHARGING, requireCharging)
        .putBoolean(PAUSE_LOW_BATTERY, pauseOnLowBattery)
        .apply()
    }

    fun schedule(context: Context, delaySeconds: Long = 15L) {
      if (!hasPendingTransfers(context)) return
      val preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val constraints = Constraints.Builder()
        .setRequiredNetworkType(if (preferences.getBoolean(WIFI_ONLY, false)) NetworkType.UNMETERED else NetworkType.CONNECTED)
        .setRequiresCharging(preferences.getBoolean(REQUIRE_CHARGING, false))
        .setRequiresBatteryNotLow(preferences.getBoolean(PAUSE_LOW_BATTERY, true))
        .setRequiresStorageNotLow(true)
        .build()
      val request = OneTimeWorkRequestBuilder<TransferRecoveryWorker>()
        .setConstraints(constraints)
        .setInitialDelay(delaySeconds.coerceAtLeast(0L), TimeUnit.SECONDS)
        .build()
      WorkManager.getInstance(context).enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.REPLACE, request)
    }

    private fun createChannel(context: Context) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.getSystemService(NotificationManager::class.java)?.createNotificationChannel(
          NotificationChannel(CHANNEL_ID, "Transfer recovery", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "Alerts when saved transfers need the app to resume"
          },
        )
      }
    }
  }
}

@Keep
class TransferRecoveryReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    if (intent?.action == Intent.ACTION_BOOT_COMPLETED || intent?.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
      TransferRecoveryWorker.schedule(context, delaySeconds = 30L)
    }
  }
}
