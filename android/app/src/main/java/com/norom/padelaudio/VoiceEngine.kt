package com.norom.padelaudio

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.BatteryManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import org.json.JSONObject
import org.vosk.Model
import org.vosk.Recognizer
import org.vosk.android.StorageService
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.sqrt

/** The model was trained on 16 kHz and cannot be fed anything else. */
private const val SAMPLE_RATE = 16000

/** A fifth of a second: often enough for the badge to keep up with speech. */
private const val CHUNK_SAMPLES = SAMPLE_RATE / 5

private const val WATCHDOG_MS = 5000L

/** Earbuds that are present but will not take the route are not asked every five seconds. */
private const val REROUTE_EVERY_MS = 30_000L

/** A live microphone is never digitally silent; this long of it means a dead route. */
private const val SILENT_CHUNKS_LIMIT = 3 * SAMPLE_RATE / CHUNK_SAMPLES

/** A route is given this many tries before the next one. */
private const val TRIES_PER_ROUTE = 2

/** On the phone's microphone, how often to look for the earbuds again. */
private const val EARBUD_RETRY_MS = 60_000L

/** After a tone: the earbuds' own echo of it must not be heard as a command. */
private const val TONE_TAIL_MS = 300L

private const val WAV_HEADER_BYTES = 44

/** Debug builds keep this much of what the microphone delivered, for pulling off the phone. */
private const val DUMP_SECONDS = 180

private class Grammar(val name: String, val phrases: String)

/**
 * A recording played into the recogniser in place of the microphone, at the
 * pace a microphone would deliver it. Debug builds only. It is how the whole
 * path — samples, Vosk, the page, the score — is tested where there is nobody
 * to speak, and how a recording made on court can be run again after a change.
 *
 *   adb push call.wav /sdcard/Android/data/com.norom.padelaudio/files/replay.wav
 *
 * 16 kHz mono 16-bit. Picked up when listening next starts; played once.
 */
private class Replay(file: File) {
    private val samples: ShortArray
    private var at = 0

    init {
        val bytes = file.readBytes()
        val body = ByteBuffer.wrap(bytes, WAV_HEADER_BYTES, bytes.size - WAV_HEADER_BYTES)
            .order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
        samples = ShortArray(body.remaining()).also { body.get(it) }
        file.delete()
    }

    /** Overwrites `chunk` with the next stretch of the recording; false once it has run out. */
    fun fill(chunk: ShortArray, length: Int): Boolean {
        if (at >= samples.size) return false

        val count = minOf(length, samples.size - at)
        System.arraycopy(samples, at, chunk, 0, count)
        chunk.fill(0, count, length)
        at += count
        return true
    }
}

/**
 * Listens through the earbuds and reports what it recognised.
 *
 * It records for itself rather than using Android's recogniser, because only
 * the process that owns the recorder can choose its microphone. Words go to the
 * page exactly as Vosk produced them — what counts as a command, and what to do
 * about it, is decided there, where it is tested.
 */
class VoiceEngine(
    private val context: Context,
    private val tones: Tones,
    private val emit: (method: String, json: String) -> Unit,
) {
    private val main = Handler(Looper.getMainLooper())
    private val router = AudioRouter(context, ::trace) { main.post { restartCapture() } }

    private var model: Model? = null
    private var loading = false
    private var running = false
    private var enabled = true
    private var capture: CaptureThread? = null

    /** Set from the page, picked up by the capture thread: Vosk is not thread-safe. */
    private val wantedGrammar = AtomicReference<Grammar?>(null)

    private var lastReroute = 0L

    /** Which way of reaching the earbuds is in use; moves on when one fails. */
    private var route = Route.MODERN
    private var failuresOnRoute = 0
    private var lastEarbudRetry = 0L

    @Volatile private var gateUntil = 0L
    @Volatile private var state = "off"
    @Volatile private var message = ""

    private val watchdog = object : Runnable {
        override fun run() {
            if (!running) return

            // Multipoint earbuds wander off to another phone; a call steals the
            // route. Ask for it back, and start over if the recorder lost it.
            router.reassert()
            val thread = capture
            val now = SystemClock.elapsedRealtime()
            val misrouted = thread != null && thread.routeKnown && !thread.onEarbuds &&
                router.earbuds() != null && now - lastReroute > REROUTE_EVERY_MS

            if (thread != null && thread.dead) {
                trace("recorder ended: ${thread.ending}")
                nextRoute()
                lastReroute = now
                restartCapture()
            } else if (thread != null && misrouted) {
                restartCapture()
            } else if (route == Route.PHONE && router.earbuds() != null && now - lastEarbudRetry > EARBUD_RETRY_MS) {
                trace("earbuds present, trying them again")
                lastEarbudRetry = now
                route = Route.MODERN
                failuresOnRoute = 0
                restartCapture()
            }
            publishStatus()
            main.postDelayed(this, WATCHDOG_MS)
        }
    }

    // ---------------------------------------------------------------- control

    fun start() {
        if (running) return
        running = true

        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            setState("no-permission", "Microphone not allowed")
            running = false
            return
        }

        main.postDelayed(watchdog, WATCHDOG_MS)
        if (model == null) loadModel() else startCapture()
    }

    fun stop() {
        if (!running) return
        running = false

        main.removeCallbacks(watchdog)
        stopCapture()
        router.release()
        setState("off", "")
    }

    fun setGrammar(name: String, phrasesJson: String) {
        wantedGrammar.set(Grammar(name, phrasesJson))
    }

    fun setEnabled(on: Boolean) {
        enabled = on
        publishStatus()
    }

    /** Plays a tone and keeps the recogniser from hearing it. */
    fun tone(kind: String) {
        val durationMs = tones.play(kind)
        gateUntil = SystemClock.elapsedRealtime() + durationMs + TONE_TAIL_MS
    }

    // ------------------------------------------------------------------ model

    /**
     * Kaldi reads its model from real files, so the first run copies it out of
     * the APK — a few seconds, once. Later runs only check that it is current.
     */
    private fun loadModel() {
        if (loading) return
        loading = true
        setState("loading", "Preparing the speech model")

        StorageService.unpack(
            context, "model-ru", "model",
            { loaded ->
                loading = false
                model = loaded
                if (running) startCapture()
            },
            { error ->
                loading = false
                setState("error", "Speech model failed to load: ${error.message}")
            },
        )
    }

    // ---------------------------------------------------------------- capture

    private fun nextRoute() {
        failuresOnRoute++
        if (failuresOnRoute < TRIES_PER_ROUTE || route == Route.PHONE) return

        failuresOnRoute = 0
        route = Route.values()[route.ordinal + 1]
        lastEarbudRetry = SystemClock.elapsedRealtime()
        trace("moving to route ${route.name.lowercase()}")
    }

    /** A line in the page's log, so what happened on the phone travels with the report. */
    private fun trace(text: String) {
        emit("log", JSONObject().put("t", System.currentTimeMillis()).put("text", text).toString())
    }

    private fun startCapture() {
        setState("loading", "Finding the microphone")

        router.acquire(route) { routed ->
            if (!running) return@acquire
            capture = CaptureThread(model!!, routed).also { it.start() }
        }
    }

    private fun stopCapture() {
        capture?.finish()
        capture = null
    }

    private fun restartCapture() {
        if (!running || model == null) return
        stopCapture()
        startCapture()
    }

    private inner class CaptureThread(
        private val model: Model,
        private val routed: Routed,
    ) : Thread("padel-voice") {

        @Volatile private var stopping = false
        @Volatile var dead = false
        @Volatile var ending = ""
        @Volatile var routeKnown = false
        @Volatile var onEarbuds = false
        @Volatile var deviceName = ""
        @Volatile var grammarName = ""
        @Volatile var load = 0.0

        /** What the microphone is delivering right now, so silence shows as silence. */
        @Volatile var levelDb = -100.0
        @Volatile var peak = 0
        @Volatile var chunks = 0L
        @Volatile var partials = 0L
        @Volatile var finals = 0L

        fun finish() {
            stopping = true
            join(1500)
        }

        @SuppressLint("MissingPermission") // checked in start()
        override fun run() {
            val minimum = AudioRecord.getMinBufferSize(
                SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
            )

            // VOICE_COMMUNICATION is the source every phone routes to the call
            // link. A second of buffer rides out a slow decode without dropping audio.
            val record = AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                max(minimum, SAMPLE_RATE * 2),
            )

            var recognizer: Recognizer? = null
            var dump: FileOutputStream? = null

            try {
                if (record.state != AudioRecord.STATE_INITIALIZED) {
                    ending = "AudioRecord not initialised"
                    setState("error", "The microphone could not be opened")
                    return
                }
                routed.input?.let {
                    val pinned = record.setPreferredDevice(it)
                    trace("pinned recorder to ${router.describe(it)} -> $pinned")
                }
                record.startRecording()
                trace("recording; state=${record.recordingState} routed=${router.describe(record.routedDevice)}")

                val chunk = ShortArray(CHUNK_SAMPLES)
                var applied: Grammar? = null
                var lastPartial = ""
                var silentChunks = 0
                var wasGated = false
                var sumSquares = 0.0
                var samples = 0L
                var replay = openReplay()
                dump = openDump()
                var dumped = 0L

                while (!stopping) {
                    val read = record.read(chunk, 0, chunk.size)
                    if (read <= 0) {
                        ending = "read returned $read"
                        break
                    }

                    if (!routeKnown) {
                        // What the recorder was actually given, not what was asked for.
                        val device = record.routedDevice
                        onEarbuds = routed.earbuds || (device != null && device.type in
                            listOf(AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLUETOOTH_SCO))
                        deviceName = device?.productName?.toString() ?: ""
                        routeKnown = true
                        trace("first audio; routed to ${router.describe(device)}")
                        setState("listening", "")
                    }

                    // The microphone is still read, so the recording arrives in real time.
                    if (replay != null && !replay.fill(chunk, read)) replay = null

                    chunks++
                    var squares = 0.0
                    var loudest = 0
                    for (i in 0 until read) {
                        val v = chunk[i].toInt()
                        squares += v.toDouble() * v
                        if (v > loudest) loudest = v else if (-v > loudest) loudest = -v
                    }
                    peak = loudest
                    levelDb = level(squares, read.toLong())
                    silentChunks = if (loudest == 0) silentChunks + 1 else 0
                    if (silentChunks > SILENT_CHUNKS_LIMIT) {
                        ending = "3 s of digital silence"
                        break
                    }

                    if (dump != null) {
                        val bytes = ByteBuffer.allocate(read * 2).order(ByteOrder.LITTLE_ENDIAN)
                        bytes.asShortBuffer().put(chunk, 0, read)
                        dump.write(bytes.array())
                        dumped += read
                        if (dumped >= DUMP_SECONDS.toLong() * SAMPLE_RATE) {
                            dump.close()
                            dump = null
                        }
                    }
                    // The recorder keeps running whatever happens: an app holding
                    // communication mode with nothing recording loses the mode.
                    val wanted = wantedGrammar.get()
                    if (wanted == null || !enabled) continue

                    val gated = SystemClock.elapsedRealtime() < gateUntil
                    if (gated) {
                        wasGated = true
                        continue
                    }

                    if (wanted !== applied) {
                        // A new recogniser rather than setGrammar() on this one:
                        // Vosk refuses a grammar mid-utterance, and refuses by
                        // aborting the process. Building one takes ~60 ms and
                        // happens twice per tie-break.
                        recognizer?.close()
                        recognizer = Recognizer(model, SAMPLE_RATE.toFloat(), wanted.phrases).apply { setWords(true) }
                        applied = wanted
                        grammarName = wanted.name
                        if (lastPartial.isNotEmpty()) emitPartial("")
                        lastPartial = ""
                        sumSquares = 0.0
                        samples = 0
                    } else if (wasGated) {
                        recognizer!!.reset()
                        lastPartial = ""
                    }
                    wasGated = false

                    val active = recognizer!!
                    val began = SystemClock.elapsedRealtimeNanos()
                    val finished = active.acceptWaveForm(chunk, read)
                    val spent = (SystemClock.elapsedRealtimeNanos() - began) / 1e9
                    load = 0.9 * load + 0.1 * (spent / (read.toDouble() / SAMPLE_RATE))

                    if (finished) {
                        finals++
                        val result = JSONObject(active.result)
                        if (result.optString("text").isNotEmpty()) {
                            emitFinal(result, level(sumSquares, samples), grammarName)
                        }
                        if (lastPartial.isNotEmpty()) emitPartial("")
                        lastPartial = ""
                        sumSquares = 0.0
                        samples = 0
                    } else {
                        val partial = JSONObject(active.partialResult).optString("partial")
                        if (partial != lastPartial) {
                            partials++
                            lastPartial = partial
                            emitPartial(partial)
                        }
                        // Loudness of the utterance only, not of the quiet around it.
                        if (partial.isNotEmpty()) {
                            for (i in 0 until read) sumSquares += chunk[i].toDouble() * chunk[i]
                            samples += read
                        }
                    }
                }
            } catch (error: Exception) {
                ending = "${error.javaClass.simpleName}: ${error.message}"
                setState("error", "Listening stopped: ${error.message}")
            } finally {
                dead = !stopping
                if (dead && ending.isEmpty()) ending = "ended without a reason"
                try {
                    record.stop()
                } catch (_: IllegalStateException) {
                }
                record.release()
                recognizer?.close()
                dump?.close()
            }
        }

        /**
         * Raw 16 kHz mono 16-bit, exactly as handed to the recogniser:
         *   adb pull /sdcard/Android/data/com.norom.padelaudio/files/capture.pcm
         *   ffmpeg -f s16le -ar 16000 -ac 1 -i capture.pcm capture.wav
         */
        private fun openDump(): FileOutputStream? {
            if (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE == 0) return null
            return try {
                FileOutputStream(File(context.getExternalFilesDir(null), "capture.pcm"))
            } catch (_: Exception) {
                null
            }
        }

        private fun openReplay(): Replay? {
            if (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE == 0) return null

            val file = File(context.getExternalFilesDir(null), "replay.wav")
            return if (file.length() > WAV_HEADER_BYTES) Replay(file) else null
        }

        /** dB relative to full scale, so −20 is a close voice and −50 is the far court. */
        private fun level(sumSquares: Double, samples: Long): Double {
            if (samples == 0L) return Double.NaN
            val rms = sqrt(sumSquares / samples)
            return if (rms <= 0) -100.0 else 20 * log10(rms / Short.MAX_VALUE)
        }
    }

    // ------------------------------------------------------------------- page

    private fun emitPartial(text: String) {
        emit("partial", JSONObject().put("text", text).toString())
    }

    private fun emitFinal(vosk: JSONObject, rms: Double, grammar: String) {
        val payload = JSONObject()
            .put("vosk", vosk)
            .put("grammar", grammar)
            .put("t", System.currentTimeMillis())
        if (!rms.isNaN()) payload.put("rms", rms)

        emit("final", payload.toString())
    }

    private fun setState(next: String, text: String) {
        state = next
        message = text
        publishStatus()
    }

    /** Also called when the page arrives late and missed what was said before. */
    fun publishStatus() {
        val thread = capture
        val listening = state == "listening" && thread != null
        val battery = (context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager)
            .getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)

        val status = JSONObject()
            .put("state", if (listening && !enabled) "off" else state)
            .put("message", if (listening && !enabled) "Voice is off for this format" else message)
            .put("mic", if (!listening) "none" else if (thread!!.onEarbuds) "earbuds" else "phone")
            .put("device", if (listening) thread!!.deviceName else "")
            .put("grammar", if (listening) thread!!.grammarName else "")
            .put("route", route.name.lowercase().replace('_', ' '))
            .put("battery", battery)
        if (listening) {
            status.put("rtf", thread!!.load)
                .put("level", thread.levelDb)
                .put("peak", thread.peak)
                .put("chunks", thread.chunks)
                .put("partials", thread.partials)
                .put("finals", thread.finals)
        }

        emit("status", status.toString())
    }
}
