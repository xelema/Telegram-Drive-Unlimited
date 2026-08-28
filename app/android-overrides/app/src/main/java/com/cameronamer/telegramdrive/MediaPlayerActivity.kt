package com.cameronamer.telegramdrive

import android.app.PictureInPictureParams
import android.content.ComponentName
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.util.Rational
import android.graphics.Rect
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.enableEdgeToEdge
import androidx.annotation.OptIn
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import androidx.media3.ui.PlayerView
import org.json.JSONObject

/** MediaSession-backed in-app player for the authenticated loopback range stream. */
@OptIn(UnstableApi::class)
class MediaPlayerActivity : AppCompatActivity() {
  private var controllerFuture: com.google.common.util.concurrent.ListenableFuture<MediaController>? = null
  private var controller: MediaController? = null
  private lateinit var playerView: PlayerView
  private lateinit var loading: ProgressBar
  private lateinit var errorText: TextView

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    applyPreferences()

    playerView = PlayerView(this).apply {
      id = View.generateViewId()
      useController = true
      keepScreenOn = true
      contentDescription = intent.getStringExtra(EXTRA_TITLE) ?: getString(R.string.media_player_content_description)
      setShowBuffering(PlayerView.SHOW_BUFFERING_WHEN_PLAYING)
      setShowSubtitleButton(true)
      subtitleView?.setFractionalTextSize(
        0.0533f * preferences().optDouble("subtitleScale", 1.0).toFloat().coerceIn(0.75f, 1.75f),
      )
    }
    loading = ProgressBar(this)
    errorText = TextView(this).apply {
      setTextColor(android.graphics.Color.WHITE)
      setBackgroundColor(0xcc000000.toInt())
      setPadding(32, 24, 32, 24)
      textAlignment = View.TEXT_ALIGNMENT_CENTER
      visibility = View.GONE
      setOnClickListener { finish() }
    }
    val root = FrameLayout(this).apply {
      setBackgroundColor(android.graphics.Color.BLACK)
      addView(playerView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
      addView(loading, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, android.view.Gravity.CENTER))
      addView(errorText, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, android.view.Gravity.CENTER))
    }
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      view.setPadding(0, bars.top, 0, bars.bottom)
      insets
    }
    setContentView(root)
  }

  override fun onStart() {
    super.onStart()
    connectController()
  }

  override fun onStop() {
    playerView.player = null
    controller = null
    controllerFuture?.let(MediaController::releaseFuture)
    controllerFuture = null
    MainActivity.emitPlaybackHistoryChanged()
    super.onStop()
  }

  private fun connectController() {
    if (controllerFuture != null) return
    val token = SessionToken(this, ComponentName(this, PlaybackService::class.java))
    val future = MediaController.Builder(this, token).buildAsync()
    controllerFuture = future
    future.addListener({
      try {
        val mediaController = future.get()
        controller = mediaController
        playerView.player = mediaController
        mediaController.addListener(object : Player.Listener {
          override fun onPlaybackStateChanged(state: Int) {
            loading.visibility = if (state == Player.STATE_BUFFERING) View.VISIBLE else View.GONE
            updatePictureInPictureParams()
          }
          override fun onIsPlayingChanged(isPlaying: Boolean) = updatePictureInPictureParams()
          override fun onVideoSizeChanged(videoSize: VideoSize) = updatePictureInPictureParams()
          override fun onPlayerError(error: PlaybackException) {
            showError(getString(R.string.media_playback_format_error))
          }
        })
        prepareMedia(mediaController)
      } catch (_: Exception) {
        showError(getString(R.string.media_session_start_error))
      }
    }, ContextCompat.getMainExecutor(this))
  }

  private fun prepareMedia(player: MediaController) {
    val streamUrl = intent.getStringExtra(EXTRA_STREAM_URL)
    if (streamUrl.isNullOrBlank() || !streamUrl.startsWith("http://localhost:")) {
      showError(getString(R.string.media_stream_unavailable_error))
      return
    }
    val mediaId = intent.getStringExtra(EXTRA_MEDIA_ID)?.takeIf { it.isNotBlank() } ?: "telegram-drive-media"
    if (player.currentMediaItem?.mediaId == mediaId) return
    val privateMetadata = preferences().optBoolean("privateMetadata", true)
    val visibleTitle = if (privateMetadata) getString(R.string.media_private_title) else intent.getStringExtra(EXTRA_TITLE) ?: getString(R.string.media_default_title)
    val mediaItem = MediaItem.Builder()
      .setUri(streamUrl)
      .setMediaId(mediaId)
      .setMimeType(intent.getStringExtra(EXTRA_MIME_TYPE))
      .setMediaMetadata(MediaMetadata.Builder().setTitle(visibleTitle).setDisplayTitle(visibleTitle).build())
      .build()
    player.setMediaItem(mediaItem, PlaybackService.getResumePosition(this, mediaId))
    player.setPlaybackSpeed(preferences().optDouble("playbackSpeed", 1.0).toFloat().coerceIn(0.5f, 2.0f))
    player.prepare()
    player.play()
  }

  private fun preferences(): JSONObject = try {
    JSONObject(intent.getStringExtra(EXTRA_PREFERENCES) ?: "{}")
  } catch (_: Exception) {
    JSONObject()
  }

  private fun applyPreferences() {
    val preferences = preferences()
    if (preferences.optBoolean("privacyScreen", false)) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    requestedOrientation = when (preferences.optString("orientation", "auto")) {
      "landscape" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
      "portrait" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
      else -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
    }
  }

  private fun showError(message: String) {
    loading.visibility = View.GONE
    errorText.text = message
    errorText.visibility = View.VISIBLE
  }

  private fun updatePictureInPictureParams() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val size = controller?.videoSize
    val width = size?.width ?: 16
    val height = size?.height ?: 9
    if (width > 0 && height > 0) {
      val builder = PictureInPictureParams.Builder().setAspectRatio(Rational(width, height))
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        val source = Rect()
        if (playerView.getGlobalVisibleRect(source)) builder.setSourceRectHint(source)
        builder.setAutoEnterEnabled(controller?.isPlaying == true)
      }
      setPictureInPictureParams(builder.build())
    }
  }

  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    val size = controller?.videoSize
    if (Build.VERSION.SDK_INT in Build.VERSION_CODES.O until Build.VERSION_CODES.S && controller?.isPlaying == true &&
      size != null && size.width > 0 && size.height > 0) {
      enterPictureInPictureMode(PictureInPictureParams.Builder().build())
    }
  }

  override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
    super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
    playerView.useController = !isInPictureInPictureMode
  }

  companion object {
    const val EXTRA_STREAM_URL = "stream_url"
    const val EXTRA_TITLE = "title"
    const val EXTRA_MIME_TYPE = "mime_type"
    const val EXTRA_MEDIA_ID = "media_id"
    const val EXTRA_PREFERENCES = "preferences"
  }
}
