package com.cameronamer.telegramdrive

import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Android 13+ needs POST_NOTIFICATIONS granted for the upload
    // foreground-service notification to be visible.
    if (Build.VERSION.SDK_INT >= 33) {
      if (ContextCompat.checkSelfPermission(this, "android.permission.POST_NOTIFICATIONS")
          != PackageManager.PERMISSION_GRANTED) {
        ActivityCompat.requestPermissions(
          this, arrayOf("android.permission.POST_NOTIFICATIONS"), 1001
        )
      }
    }
  }
}
