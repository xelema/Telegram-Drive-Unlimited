-keepattributes *Annotation*

# Rust resolves these classes and their static Kotlin bridges by literal JNI names.
# Keep the complete boundary so release minification cannot remove a newly added
# JNI entry point that has no Java/Kotlin caller.
-keep class com.cameronamer.telegramdrive.MainActivity { *; }
-keep class com.cameronamer.telegramdrive.UploadForegroundService { *; }
-keep class com.cameronamer.telegramdrive.MediaPlayerActivity { *; }
-keep class com.cameronamer.telegramdrive.PlaybackService { *; }
-keep class com.cameronamer.telegramdrive.TransferJobService { *; }
-keep class com.cameronamer.telegramdrive.TransferRecoveryWorker { *; }
-keep class com.cameronamer.telegramdrive.TelegramDriveApplication { *; }
