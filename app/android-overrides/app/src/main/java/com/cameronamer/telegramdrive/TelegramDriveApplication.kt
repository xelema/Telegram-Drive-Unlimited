package com.cameronamer.telegramdrive

import android.app.Application
import androidx.annotation.Keep
import androidx.work.Configuration

/** Keeps WorkManager's JobScheduler IDs away from Telegram Drive's UIDT job ID (2028). */
@Keep
class TelegramDriveApplication : Application(), Configuration.Provider {
  override val workManagerConfiguration: Configuration
    get() = Configuration.Builder()
      .setJobSchedulerJobIdRange(10_000, 10_999)
      .build()
}
