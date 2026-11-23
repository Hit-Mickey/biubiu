package com.hitmickey.biubiu

import android.app.*
import android.content.*
import android.graphics.drawable.Icon
import android.media.*
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.*
import org.json.JSONObject

internal object PhoneControls {
    @JvmStatic external fun command(action: Int, value: Long)
}

/** Android is a media controller. Rust owns playback, queue progression and saved position. */
class PlaybackService : Service() {
    companion object {
        private const val CHANNEL = "playback"
        private const val ID = 12
        private var current: PlaybackService? = null
        private var snapshot = JSONObject()
        fun update(context: Context, state: JSONObject) {
            snapshot = state
            if (current != null) current!!.sync()
            else if (state.optBoolean("playing")) context.startForegroundService(Intent(context, PlaybackService::class.java))
        }
    }

    private lateinit var session: MediaSession
    private lateinit var audio: AudioManager
    private lateinit var focus: AudioFocusRequest
    private lateinit var wake: PowerManager.WakeLock
    private val notificationArtwork by lazy { Icon.createWithResource(this, R.mipmap.ic_launcher_round) }
    private val mediaArtworkUri by lazy {
        "${ContentResolver.SCHEME_ANDROID_RESOURCE}://$packageName/${R.drawable.media_artwork}"
    }
    private var focused = false
    private val becomingNoisy = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) { PhoneControls.command(2, 0) }
    }

    override fun onCreate() {
        super.onCreate()
        current = this
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "音乐播放", NotificationManager.IMPORTANCE_LOW))
        wake = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "BiuBiu:playback")
        audio = getSystemService(AudioManager::class.java)
        focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
            .setOnAudioFocusChangeListener { if (it < 0) PhoneControls.command(2, 0) }.build()
        session = MediaSession(this, "BiuBiu").apply {
            setCallback(object : MediaSession.Callback() {
                override fun onPlay() = PhoneControls.command(1, 0)
                override fun onPause() = PhoneControls.command(2, 0)
                override fun onStop() { PhoneControls.command(2, 0); stopSelf() }
                override fun onSkipToNext() = PhoneControls.command(3, 0)
                override fun onSkipToPrevious() = PhoneControls.command(4, 0)
                override fun onSeekTo(pos: Long) = PhoneControls.command(5, pos)
            })
            setSessionActivity(launchIntent())
            isActive = true
        }
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(becomingNoisy, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY), RECEIVER_NOT_EXPORTED)
        else registerReceiver(becomingNoisy, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY))
    }

    private fun launchIntent() = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    private fun action(command: Int, icon: Int, name: String): Notification.Action {
        val intent = Intent(this, PlaybackService::class.java).putExtra("command", command)
        return Notification.Action.Builder(Icon.createWithResource(this, icon), name,
            PendingIntent.getService(this, command, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)).build()
    }
    private fun sync() {
        val playing = snapshot.optBoolean("playing")
        val title = snapshot.optString("title", "BiuBiu")
        val artist = snapshot.optString("artist", "")
        session.setMetadata(MediaMetadata.Builder().putString(MediaMetadata.METADATA_KEY_TITLE,title)
            .putString(MediaMetadata.METADATA_KEY_ARTIST,artist)
            .putString(MediaMetadata.METADATA_KEY_DISPLAY_ICON_URI, mediaArtworkUri)
            .putString(MediaMetadata.METADATA_KEY_ART_URI, mediaArtworkUri)
            .putLong(MediaMetadata.METADATA_KEY_DURATION,(snapshot.optDouble("duration",0.0)*1000).toLong()).build())
        session.setPlaybackState(PlaybackState.Builder()
            .setActions(PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or
                PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS or PlaybackState.ACTION_SEEK_TO)
            .setState(if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
                (snapshot.optDouble("position",0.0)*1000).toLong(),if (playing) snapshot.optDouble("rate",1.0).toFloat() else 0f).build())
        val notification = Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_playback).setLargeIcon(notificationArtwork)
            .setColor(0xff1088ff.toInt()).setContentTitle(title).setContentText(artist)
            .setContentIntent(launchIntent()).setOnlyAlertOnce(true).setShowWhen(false)
            .addAction(action(4, android.R.drawable.ic_media_previous, "上一首"))
            .addAction(action(if(playing) 2 else 1, if(playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
                if (playing) "暂停" else "播放"))
            .addAction(action(3, android.R.drawable.ic_media_next, "下一首"))
            .setStyle(Notification.MediaStyle().setMediaSession(session.sessionToken).setShowActionsInCompactView(0,1,2)).build()
        startForeground(ID, notification)
        if (playing) {
            if (!wake.isHeld) wake.acquire()
            if (!focused) {
                focused = audio.requestAudioFocus(focus) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
                if (!focused) PhoneControls.command(2, 0)
            }
        } else {
            if (focused) audio.abandonAudioFocusRequest(focus)
            focused = false
            if (wake.isHeld) wake.release()
            stopForeground(STOP_FOREGROUND_DETACH)
            if (!snapshot.optBoolean("hasTrack")) stopSelf()
        }
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        sync()
        intent?.getIntExtra("command", 0)?.takeIf { it in 1..4 }?.let { PhoneControls.command(it, 0) }
        return START_NOT_STICKY
    }
    override fun onBind(intent: Intent?) = null
    override fun onDestroy() {
        current = null
        unregisterReceiver(becomingNoisy)
        if (focused) audio.abandonAudioFocusRequest(focus)
        if (wake.isHeld) wake.release()
        session.release()
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }
}
