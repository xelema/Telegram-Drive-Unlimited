package com.cameronamer.telegramdrive

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

class UploadForegroundService : Service() {
    companion object {
        const val CHANNEL_ID = "tdsp_upload"
        const val NOTIF_ID = 4201

        @Volatile
        private var instance: UploadForegroundService? = null

        @JvmStatic
        fun startService(context: Context) {
            val intent = Intent(context, UploadForegroundService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        @JvmStatic
        fun stopService(context: Context) {
            context.stopService(Intent(context, UploadForegroundService::class.java))
        }

        @JvmStatic
        fun updateProgress(context: Context, percent: Int, text: String) {
            instance?.update(percent, text)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = buildNotification(0, "Preparing upload")
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIF_ID, notification)
        }
        return START_STICKY
    }

    override fun onDestroy() {
        instance = null
        super.onDestroy()
    }

    private fun update(percent: Int, text: String) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIF_ID, buildNotification(percent, text))
    }

    private fun buildNotification(percent: Int, text: String): Notification {
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Telegram Drive")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
        if (percent in 0..100) {
            builder.setProgress(100, percent, false)
        }
        return builder.build()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Uploads",
                NotificationManager.IMPORTANCE_LOW
            )
            channel.setShowBadge(false)
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(channel)
        }
    }
}
