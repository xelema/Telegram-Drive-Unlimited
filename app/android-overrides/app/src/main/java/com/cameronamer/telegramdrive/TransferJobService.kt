package com.cameronamer.telegramdrive

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.annotation.Keep
import androidx.core.app.NotificationCompat

/**
 * Android 14+ lifecycle owner for a transfer explicitly started by the user.
 * Telegram/Rust still performs the byte transfer in-process; the UIDT job tells
 * Android that this work is user-visible and gives the OS a supported stop path.
 */
@Keep
class TransferJobService : JobService() {
  override fun onStartJob(params: JobParameters): Boolean {
    createChannel(this)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      setNotification(
        params,
        NOTIFICATION_ID,
        createNotification(this),
        JOB_END_NOTIFICATION_POLICY_REMOVE,
      )
    }
    return true
  }

  override fun onStopJob(params: JobParameters): Boolean {
    MainActivity.emitTransferAction("pause")
    TransferRecoveryWorker.schedule(this)
    return true
  }

  companion object {
    private const val JOB_ID = 2028
    private const val CHANNEL_ID = "UserInitiatedTransferChannel"
    private const val NOTIFICATION_ID = 2028
    private const val PREFS = "telegram_drive_transfer_recovery_v1"
    const val ACTION_PAUSE = "com.cameronamer.telegramdrive.UIDT_PAUSE"
    const val ACTION_RESUME = "com.cameronamer.telegramdrive.UIDT_RESUME"
    const val ACTION_CANCEL = "com.cameronamer.telegramdrive.UIDT_CANCEL"

    fun schedule(context: Context): Boolean {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return false
      return try {
        val preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val networkType = if (preferences.getBoolean("wifi_only", false)) {
          JobInfo.NETWORK_TYPE_UNMETERED
        } else {
          JobInfo.NETWORK_TYPE_ANY
        }
        val job = JobInfo.Builder(JOB_ID, ComponentName(context, TransferJobService::class.java))
          .setRequiredNetworkType(networkType)
          .setRequiresCharging(preferences.getBoolean("require_charging", false))
          .setRequiresBatteryNotLow(preferences.getBoolean("pause_low_battery", true))
          .setRequiresStorageNotLow(true)
          .setUserInitiated(true)
          .build()
        context.getSystemService(JobScheduler::class.java)?.schedule(job) == JobScheduler.RESULT_SUCCESS
      } catch (error: Exception) {
        android.util.Log.w("TransferJob", "Unable to schedule UIDT job; using foreground-service fallback", error)
        false
      }
    }

    fun isPending(context: Context): Boolean {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return false
      return context.getSystemService(JobScheduler::class.java)?.getPendingJob(JOB_ID) != null
    }

    fun update(context: Context, active: Int, progress: Int, speed: Long, paused: Boolean) {
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
        .putInt("active_count", active.coerceAtLeast(0))
        .putInt("progress", progress.coerceIn(0, 100))
        .putLong("speed", speed.coerceAtLeast(0L))
        .putBoolean("paused", paused)
        .apply()
      createChannel(context)
      context.getSystemService(NotificationManager::class.java)
        ?.notify(NOTIFICATION_ID, createNotification(context))
    }

    fun cancel(context: Context) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        context.getSystemService(JobScheduler::class.java)?.cancel(JOB_ID)
      }
      context.getSystemService(NotificationManager::class.java)?.cancel(NOTIFICATION_ID)
    }

    private fun action(context: Context, action: String, requestCode: Int) = PendingIntent.getBroadcast(
      context,
      requestCode,
      Intent(context, TransferActionReceiver::class.java).setAction(action),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    private fun createNotification(context: Context): Notification {
      val preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val active = preferences.getInt("active_count", 0)
      val progress = preferences.getInt("progress", 0)
      val speed = preferences.getLong("speed", 0L)
      val paused = preferences.getBoolean("paused", false)
      val openApp = PendingIntent.getActivity(
        context,
        0,
        Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      val state = when {
        paused -> "Transfers paused"
        active > 0 && speed > 0 -> "$active active · ${formatSpeed(speed)}"
        active > 0 -> "$active transfer${if (active == 1) "" else "s"} active"
        else -> "Preparing transfers…"
      }
      return NotificationCompat.Builder(context, CHANNEL_ID)
        .setContentTitle("Telegram Drive transfers")
        .setContentText(state)
        .setSmallIcon(if (paused) android.R.drawable.ic_media_pause else android.R.drawable.stat_sys_upload)
        .setContentIntent(openApp)
        .setOnlyAlertOnce(true)
        .setOngoing(true)
        .setCategory(NotificationCompat.CATEGORY_PROGRESS)
        .setProgress(100, progress, active == 0)
        .addAction(
          if (paused) android.R.drawable.ic_media_play else android.R.drawable.ic_media_pause,
          if (paused) "Resume" else "Pause",
          action(context, if (paused) ACTION_RESUME else ACTION_PAUSE, 21),
        )
        .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Cancel", action(context, ACTION_CANCEL, 22))
        .build()
    }

    private fun createChannel(context: Context) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.getSystemService(NotificationManager::class.java)?.createNotificationChannel(
          NotificationChannel(CHANNEL_ID, "User-initiated transfers", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Upload and download progress"
            setShowBadge(false)
          },
        )
      }
    }

    private fun formatSpeed(bytes: Long): String {
      val units = arrayOf("B", "KB", "MB", "GB")
      var value = bytes.toDouble()
      var unit = 0
      while (value >= 1024.0 && unit < units.lastIndex) { value /= 1024.0; unit++ }
      return String.format(java.util.Locale.US, "%.1f %s/s", value, units[unit])
    }
  }
}

@Keep
class TransferActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    when (intent?.action) {
      TransferJobService.ACTION_PAUSE -> {
        MainActivity.emitTransferAction("pause")
        TransferJobService.update(context, 0, 0, 0L, true)
      }
      TransferJobService.ACTION_RESUME -> MainActivity.emitTransferAction("resume")
      TransferJobService.ACTION_CANCEL -> {
        MainActivity.emitTransferAction("cancel")
        TransferRecoveryWorker.setPendingTransfers(context, false)
        TransferJobService.cancel(context)
      }
    }
  }
}
