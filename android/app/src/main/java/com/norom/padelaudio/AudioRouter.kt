package com.norom.padelaudio

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Handler
import android.os.Looper

private const val ROUTE_TIMEOUT_MS = 5000L

/** Earbuds first; LE Audio ahead of classic because a phone offering both prefers it. */
private val EARBUD_TYPES = listOf(AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLUETOOTH_SCO)

/**
 * Gets the microphone in the wearer's ear rather than the one in the phone.
 *
 * A Bluetooth headset only sends its microphone over the call link, and Android
 * only brings that link up for an app that says it is in a call. So this puts
 * the audio system in communication mode and names the earbuds as the
 * communication device — and, because the order matters, reports back only once
 * the system confirms the route. A recorder opened before that is quietly given
 * the phone's own microphone, which courtside hears the whole court.
 */
class AudioRouter(private val context: Context, private val onDevicesChanged: () -> Unit) {

    private val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val main = Handler(Looper.getMainLooper())

    private var listener: AudioManager.OnCommunicationDeviceChangedListener? = null
    private var timeout: Runnable? = null
    private var held = false

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

    /** True while the system's communication route is the earbuds. */
    fun onEarbuds(): Boolean = audio.communicationDevice?.type in EARBUD_TYPES

    /**
     * Take the route, then call back on the main thread with the input to record
     * from — or null for the phone's microphone, when there are no earbuds or
     * the system would not route to them in time.
     */
    fun acquire(onReady: (AudioDeviceInfo?) -> Unit) {
        release()
        held = true

        audio.mode = AudioManager.MODE_IN_COMMUNICATION
        audio.registerAudioDeviceCallback(deviceCallback, main)

        val wanted = earbuds()
        if (wanted == null || !audio.setCommunicationDevice(wanted)) {
            onReady(null)
            return
        }

        var answered = false
        fun answer(routed: Boolean) {
            if (answered) return
            answered = true
            clearWait()
            onReady(if (routed) inputFor(wanted) else null)
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

    /** Ask again for the earbuds. Cheap, and harmless when they already have the route. */
    fun reassert() {
        if (!held) return
        earbuds()?.let { audio.setCommunicationDevice(it) }
    }

    /** Give the audio system back exactly as it was found, or calls and music suffer. */
    fun release() {
        clearWait()
        if (!held) return
        held = false

        audio.unregisterAudioDeviceCallback(deviceCallback)
        audio.clearCommunicationDevice()
        audio.mode = AudioManager.MODE_NORMAL
    }

    private fun clearWait() {
        listener?.let { audio.removeOnCommunicationDeviceChangedListener(it) }
        listener = null
        timeout?.let { main.removeCallbacks(it) }
        timeout = null
    }

    /** The recording side of the same headset: outputs and inputs are listed apart. */
    private fun inputFor(device: AudioDeviceInfo): AudioDeviceInfo? {
        val inputs = audio.getDevices(AudioManager.GET_DEVICES_INPUTS).filter { it.type == device.type }
        return inputs.firstOrNull { it.address == device.address } ?: inputs.firstOrNull()
    }
}
