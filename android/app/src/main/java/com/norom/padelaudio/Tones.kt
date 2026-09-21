package com.norom.padelaudio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Handler
import android.os.Looper
import kotlin.math.PI
import kotlin.math.min
import kotlin.math.sin

private const val SAMPLE_RATE = 16000
private const val FADE_MS = 8
private const val LEVEL = 0.5

/** A note, or a rest when `hz` is zero. */
private class Beat(val hz: Int, val ms: Int)

/**
 * The three answers the wearer hears.
 *
 * Told apart by shape rather than pitch: open-ear buds have next to no bass, so
 * "low means no" would not survive the court. Everything sits between 400 and
 * 2000 Hz, where they are loudest.
 *
 *   ok       one short blip
 *   confirm  two notes rising, like a question — say it again
 *   fail     two long flat notes
 *
 * Played as call audio. While the earbuds' microphone is in use their music
 * link is suspended, and a tone sent as media may simply not arrive.
 */
class Tones {

    private val main = Handler(Looper.getMainLooper())

    private val shapes = mapOf(
        "ok" to listOf(Beat(1320, 90)),
        "confirm" to listOf(Beat(880, 90), Beat(0, 40), Beat(1320, 110)),
        "fail" to listOf(Beat(440, 150), Beat(0, 70), Beat(440, 150)),
    )

    /** Plays the tone and returns how long it lasts, so the recogniser can look away. */
    fun play(kind: String): Int {
        val beats = shapes[kind] ?: return 0
        val pcm = render(beats)
        val durationMs = beats.sumOf { it.ms }

        val track = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setSampleRate(SAMPLE_RATE)
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build()
            )
            .setTransferMode(AudioTrack.MODE_STATIC)
            .setBufferSizeInBytes(pcm.size * 2)
            .build()

        track.write(pcm, 0, pcm.size)
        track.play()
        main.postDelayed({ track.release() }, durationMs + 250L)

        return durationMs
    }

    private fun render(beats: List<Beat>): ShortArray {
        val fade = SAMPLE_RATE * FADE_MS / 1000
        val out = ArrayList<Short>()

        for (beat in beats) {
            val length = SAMPLE_RATE * beat.ms / 1000
            for (i in 0 until length) {
                // Faded at both ends: a tone that starts at full level clicks.
                val edge = min(1.0, min(i, length - 1 - i).toDouble() / fade)
                val wave = if (beat.hz == 0) 0.0 else sin(2 * PI * beat.hz * i / SAMPLE_RATE)
                out.add((wave * edge * LEVEL * Short.MAX_VALUE).toInt().toShort())
            }
        }
        return out.toShortArray()
    }
}
