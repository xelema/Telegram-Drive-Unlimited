package com.cameronamer.telegramdrive

import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.FeatureInfo
import android.content.pm.PackageManager
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AndroidPlatformContractTest {
  private val context = ApplicationProvider.getApplicationContext<android.content.Context>()
  private val packageManager = context.packageManager

  @Test
  fun packageSupportsPhoneAndTelevisionLaunchers() {
    val phoneIntent = Intent(Intent.ACTION_MAIN)
      .addCategory(Intent.CATEGORY_LAUNCHER)
      .setPackage(context.packageName)
    val televisionIntent = Intent(Intent.ACTION_MAIN)
      .addCategory(Intent.CATEGORY_LEANBACK_LAUNCHER)
      .setPackage(context.packageName)

    assertTrue(
      "The standard Android launcher activity must be discoverable",
      packageManager.queryIntentActivities(phoneIntent, PackageManager.MATCH_ALL).isNotEmpty()
    )
    assertTrue(
      "The Android/Google TV Leanback launcher activity must be discoverable",
      packageManager.queryIntentActivities(televisionIntent, PackageManager.MATCH_ALL).isNotEmpty()
    )
  }

  @Suppress("DEPRECATION")
  @Test
  fun backupIsDisabledAndTelevisionBannerIsPackaged() {
    val applicationInfo = packageManager.getApplicationInfo(context.packageName, 0)
    assertEquals(0, applicationInfo.flags and ApplicationInfo.FLAG_ALLOW_BACKUP)
    assertNotEquals(0, applicationInfo.banner)
  }

  @Suppress("DEPRECATION")
  @Test
  fun touchscreenIsOptional() {
    val packageInfo = packageManager.getPackageInfo(context.packageName, PackageManager.GET_CONFIGURATIONS)
    val touchscreen = packageInfo.reqFeatures?.firstOrNull { it.name == PackageManager.FEATURE_TOUCHSCREEN }
    assertTrue(touchscreen == null || touchscreen.flags and FeatureInfo.FLAG_REQUIRED == 0)
  }
}
