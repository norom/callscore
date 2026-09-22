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

/** The system names the device before the call link is up; give the link this long. */
private const val LINK_TIMEOUT_MS = 3000L

/** Earbuds first; LE Audio ahead of classic because a phone offering both prefers it. */
private val EARBUD_TYPES = listOf(AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLUETOOTH_SCO)

/**
 * The ways of asking for the earbuds' microphone, in the order they are tried.
 *
 * MODERN is the documented Android 12+ way. Some phones grant it and then send
 * silence, so if the recorder hears nothing the next one is tried:
 *
 *   MODERN          setCommunicationDevice; the system picks the input
 *   MODERN_PINNED   the same, with the recorder pinned to the earbuds' input
 *   LEGACY_SCO      the pre-12 call: startBluetoothSco, which every phone shipped with
 *   PHONE           give up on the earbuds for now and use the phone's microphone
 */
enum class Route { MODERN, MODERN_PINNED, LEGACY_SCO, PHONE }

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
class AudioRouter(
    private val context: Context,
    private val trace: (String) -> Unit,
    private val onDevicesChanged: () -> Unit,
) {

    private val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val main = Handler(Looper.getMainLooper())

    private var listener: AudioManager.OnCommunicationDeviceChangedListener? = null
    private var scoReceiver: BroadcastReceiver? = null
    private var timeout: Runnable? = null
    private var held = false
    private var route = Route.MODERN

    /**
     * The earbud devices the system listed when the route was taken. Registering
     * for device changes is answered at once with the whole current list, as if
     * everything had just been plugged in; only a list that differs from this
     * one is earbuds really going into or coming out of the case.
     */
    private var knownEarbuds = emptySet<Int>()

    private fun earbudIds(): Set<Int> =
        audio.getDevices(AudioManager.GET_DEVICES_ALL).filter { it.type in EARBUD_TYPES }.map { it.id }.toSet()

    private val deviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) = changed()
        override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) = changed()

        private fun changed() {
            if (!held) return
            val now = earbudIds()
            if (now == knownEarbuds) return

            trace("earbuds ${if (now.size > knownEarbuds.size) "connected" else "disconnected"}")
            knownEarbuds = now
            onDevicesChanged()
        }
    }

    /** The earbuds, if the phone can talk through them right now. */
    fun earbuds(): AudioDeviceInfo? {
        val available = audio.availableCommunicationDevices
        return EARBUD_TYPES.firstNotNullOfOrNull { type -> available.firstOrNull { it.type == type } }
    }

    fun describe(device: AudioDeviceInfo?): String =
        if (device == null) "none" else "${device.productName} type=${device.type} ${if (device.isSource) "in" else "out"}"

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

        knownEarbuds = earbudIds()
        audio.registerAudioDeviceCallback(deviceCallback, main)

        val inputs = audio.getDevices(AudioManager.GET_DEVICES_INPUTS).joinToString { describe(it) }
        val comm = audio.availableCommunicationDevices.joinToString { describe(it) }
        trace("route ${route.name.lowercase()}: inputs [$inputs]; communication devices [$comm]")

        if (route == Route.PHONE) {
            audio.mode = AudioManager.MODE_NORMAL
            onReady(Routed(null, false))
            return
        }

        audio.mode = AudioManager.MODE_IN_COMMUNICATION
        when (route) {
            Route.LEGACY_SCO -> acquireLegacy(onReady)
            else -> acquireModern(pin = route == Route.MODERN_PINNED, onReady)
        }
    }

    private fun acquireModern(pin: Boolean, onReady: (Routed) -> Unit) {
        val wanted = earbuds()
        if (wanted == null) {
            trace("no earbuds among the communication devices")
            onReady(Routed(null, false))
            return
        }

        val accepted = audio.setCommunicationDevice(wanted)
        trace("setCommunicationDevice(${describe(wanted)}) -> $accepted; now ${describe(audio.communicationDevice)}")
        if (!accepted) {
            onReady(Routed(null, false))
            return
        }

        var answered = false
        fun answer(routed: Boolean, why: String) {
            if (answered) return
            answered = true
            clearWait()
            trace("route ${if (routed) "confirmed" else "failed"}: $why")
            onReady(Routed(if (routed && pin) inputFor(wanted) else null, routed))
        }

        // Naming the device is not the same as the call link being up. Wait for
        // the link to report itself connected, or for a moment to pass.
        fun awaitLink() {
            clearWait()
            @Suppress("DEPRECATION")
            if (audio.isBluetoothScoOn) {
                answer(true, "call link already up")
                return
            }
            scoReceiver = object : BroadcastReceiver() {
                override fun onReceive(context: Context, intent: Intent) {
                    val state = intent.getIntExtra(AudioManager.EXTRA_SCO_AUDIO_STATE, -1)
                    trace("call link state $state")
                    if (state == AudioManager.SCO_AUDIO_STATE_CONNECTED) answer(true, "call link connected")
                }
            }.also {
                context.registerReceiver(it, IntentFilter(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED))
            }
            timeout = Runnable { answer(true, "no link report within ${LINK_TIMEOUT_MS} ms, going ahead") }
                .also { main.postDelayed(it, LINK_TIMEOUT_MS) }
        }

        if (audio.communicationDevice?.type == wanted.type) {
            awaitLink()
            return
        }

        listener = AudioManager.OnCommunicationDeviceChangedListener { device ->
            trace("communication device changed to ${describe(device)}")
            if (device?.type == wanted.type) awaitLink()
        }.also { audio.addOnCommunicationDeviceChangedListener(context.mainExecutor, it) }

        timeout = Runnable { answer(false, "device never changed within ${ROUTE_TIMEOUT_MS} ms") }
            .also { main.postDelayed(it, ROUTE_TIMEOUT_MS) }
    }

    /** The old way: ask for the call link directly and wait for it to report connected. */
    @Suppress("DEPRECATION")
    private fun acquireLegacy(onReady: (Routed) -> Unit) {
        if (bluetoothInput() == null) {
            trace("no bluetooth input listed")
            onReady(Routed(null, false))
            return
        }

        var answered = false
        fun answer(routed: Boolean, why: String) {
            if (answered) return
            answered = true
            clearWait()
            trace("route ${if (routed) "confirmed" else "failed"}: $why")
            onReady(Routed(null, routed))
        }

        scoReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                val state = intent.getIntExtra(AudioManager.EXTRA_SCO_AUDIO_STATE, -1)
                trace("call link state $state")
                if (state == AudioManager.SCO_AUDIO_STATE_CONNECTED) {
                    audio.isBluetoothScoOn = true
                    answer(true, "call link connected")
                }
            }
        }.also {
            context.registerReceiver(it, IntentFilter(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED))
        }

        audio.startBluetoothSco()
        trace("startBluetoothSco() called; scoOn=${audio.isBluetoothScoOn}")
        timeout = Runnable { answer(false, "call link never connected within ${ROUTE_TIMEOUT_MS} ms") }
            .also { main.postDelayed(it, ROUTE_TIMEOUT_MS) }
    }

    /** Ask again for the earbuds. Cheap, and harmless when they already have the route. */
    @Suppress("DEPRECATION")
    fun reassert() {
        if (!held) return
        when (route) {
            Route.PHONE -> Unit
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
        when (route) {
            Route.PHONE -> Unit
            Route.LEGACY_SCO -> {
                audio.isBluetoothScoOn = false
                audio.stopBluetoothSco()
            }
            else -> audio.clearCommunicationDevice()
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
