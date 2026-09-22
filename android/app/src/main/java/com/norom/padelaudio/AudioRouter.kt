package com.norom.padelaudio

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Handler
import android.os.Looper

private const val ROUTE_TIMEOUT_MS = 5000L

/** Earbuds first; LE Audio ahead of classic because a phone offering both prefers it. */
private val EARBUD_TYPES = listOf(AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLUETOOTH_SCO)

/**
 * The ways of asking for the earbuds' microphone, in the order they are tried.
 *
 * MODERN is the documented Android 12+ way. Some phones grant it and then send
 * silence, so if the recorder hears nothing the next one is tried:
 *
 *   MODERN_PINNED   setCommunicationDevice, and the recorder pinned to the input
 *   MODERN          setCommunicationDevice alone; the system picks the input
 *   LEGACY_SCO      the pre-12 call: startBluetoothSco, which every phone shipped with
 */
enum class Route { MODERN_PINNED, MODERN, LEGACY_SCO }

/** What a route produced: the input to pin, if any, and whether earbuds were reached. */
class Routed(val input: AudioDeviceInfo?, val earbuds: Boolean)

/**
 * Gets the microphone in the wearer's ear rather than the one in the phone.
 *
 * A Bluetooth headset only sends its microphone over the call link, and Android
 * only brings that link up for an app that says it is in a call. So this puts
 * the audio system in communication mode and asks for the earbuds — and, because
 * the order matters, reports back only once the system confirms the route. A
 * recorder opened before that is quietly given the phone's own microphone.
 */
class AudioRouter(private val context: Context, private val onDevicesChanged: () -> Unit) {

    private val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val main = Handler(Looper.getMainLooper())

    private var listener: AudioManager.OnCommunicationDeviceChangedListener? = null
    private var scoReceiver: BroadcastReceiver? = null
    private var timeout: Runnable? = null
    private var held = false
    private var route = Route.MODERN_PINNED

    private val deviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) = changed(added)
        override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) = changed(removed)

        private fun changed(devices: Array<out AudioDeviceInfo>) {
            // Earbuds going into or coming out of the case. Anything else — a
            // USB cable, the speaker — is not a reason to restart the recorder.
            if (held && devices.any { it.type in EARBUD_TYPES }) onDevicesChanged()
        }
    }

    /** The earbuds, if the phone can talk through them right now. */
    fun earbuds(): AudioDeviceInfo? {
        val available = audio.availableCommunicationDevices
        return EARBUD_TYPES.firstNotNullOfOrNull { type -> available.firstOrNull { it.type == type } }
    }

    /** Any Bluetooth microphone the system lists, whichever profile it came in on. */
    private fun bluetoothInput(): AudioDeviceInfo? =
        audio.getDevices(AudioManager.GET_DEVICES_INPUTS).firstOrNull { it.type in EARBUD_TYPES }

    /**
     * Take the route, then call back on the main thread with what was reached.
     * `input` is null when the recorder should be left to the system's choice.
     */
    fun acquire(route: Route, onReady: (Routed) -> Unit) {
        release()
        held = true
        this.route = route

        audio.mode = AudioManager.MODE_IN_COMMUNICATION
        audio.registerAudioDeviceCallback(deviceCallback, main)

        when (route) {
            Route.LEGACY_SCO -> acquireLegacy(onReady)
            else -> acquireModern(pin = route == Route.MODERN_PINNED, onReady)
        }
    }

    private fun acquireModern(pin: Boolean, onReady: (Routed) -> Unit) {
        val wanted = earbuds()
        if (wanted == null || !audio.setCommunicationDevice(wanted)) {
            onReady(Routed(null, false))
            return
        }

        var answered = false
        fun answer(routed: Boolean) {
            if (answered) return
            answered = true
            clearWait()
            onReady(Routed(if (routed && pin) inputFor(wanted) else null, routed))
        }

        if (audio.communicationDevice?.type == wanted.type) {
            answer(true)
            return
        }

        listener = AudioManager.OnCommunicationDeviceChangedListener { device ->
            if (device?.type == wanted.type) answer(true)
        }.also { audio.addOnCommunicationDeviceChangedListener(context.mainExecutor, it) }

        timeout = Runnable { answer(false) }.also { main.postDelayed(it, ROUTE_TIMEOUT_MS) }
    }

    /** The old way: ask for the call link directly and wait for it to report connected. */
    @Suppress("DEPRECATION")
    private fun acquireLegacy(onReady: (Routed) -> Unit) {
        if (bluetoothInput() == null) {
            onReady(Routed(null, false))
            return
        }

        var answered = false
        fun answer(routed: Boolean) {
            if (answered) return
            answered = true
            clearWait()
            onReady(Routed(null, routed))
        }

        scoReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                val state = intent.getIntExtra(AudioManager.EXTRA_SCO_AUDIO_STATE, -1)
                if (state == AudioManager.SCO_AUDIO_STATE_CONNECTED) {
                    audio.isBluetoothScoOn = true
                    answer(true)
                }
            }
        }.also {
            context.registerReceiver(it, IntentFilter(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED))
        }

        audio.startBluetoothSco()
        timeout = Runnable { answer(false) }.also { main.postDelayed(it, ROUTE_TIMEOUT_MS) }
    }

    /** Ask again for the earbuds. Cheap, and harmless when they already have the route. */
    @Suppress("DEPRECATION")
    fun reassert() {
        if (!held) return
        when (route) {
            Route.LEGACY_SCO -> if (!audio.isBluetoothScoOn) audio.startBluetoothSco()
            else -> earbuds()?.let { audio.setCommunicationDevice(it) }
        }
    }

    /** Give the audio system back exactly as it was found, or calls and music suffer. */
    @Suppress("DEPRECATION")
    fun release() {
        clearWait()
        if (!held) return
        held = false

        audio.unregisterAudioDeviceCallback(deviceCallback)
        if (route == Route.LEGACY_SCO) {
            audio.isBluetoothScoOn = false
            audio.stopBluetoothSco()
        } else {
            audio.clearCommunicationDevice()
        }
        audio.mode = AudioManager.MODE_NORMAL
    }

    private fun clearWait() {
        listener?.let { audio.removeOnCommunicationDeviceChangedListener(it) }
        listener = null
        scoReceiver?.let { context.unregisterReceiver(it) }
        scoReceiver = null
        timeout?.let { main.removeCallbacks(it) }
        timeout = null
    }

    /** The recording side of the same headset: outputs and inputs are listed apart. */
    private fun inputFor(device: AudioDeviceInfo): AudioDeviceInfo? {
        val inputs = audio.getDevices(AudioManager.GET_DEVICES_INPUTS).filter { it.type == device.type }
        return inputs.firstOrNull { it.address == device.address } ?: inputs.firstOrNull()
    }
}
