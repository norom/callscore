package com.norom.padelaudio

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.media.AudioManager
import android.os.Bundle
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject

private const val PERMISSIONS_REQUEST = 1

/**
 * The scoreboard, wrapped so it can listen.
 *
 * Everything that keeps score — the rules, undo, persistence, the display, and
 * what a spoken phrase means — is the web app, served from the APK's assets.
 * The native side does what a page cannot: keep the screen on, record from the
 * earbud microphone, recognise speech on the device, and play a tone back.
 */
class MainActivity : Activity() {

    private lateinit var web: WebView
    private lateinit var voice: VoiceEngine

    private var visible = false

    /** ES modules are blocked on file://, so assets are served over an origin. */
    private val origin = "https://appassets.androidplatform.net"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // The tones are call audio, so the volume keys should move call volume
        // even in the quiet between them.
        volumeControlStream = AudioManager.STREAM_VOICE_CALL

        // Debug builds only: lets `chrome://inspect` and CDP attach to the page.
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web = WebView(this).apply {
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest
                ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)
            }

            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true

            setBackgroundColor(0xFF080D13.toInt())
            isVerticalScrollBarEnabled = false
            isHorizontalScrollBarEnabled = false
        }

        voice = VoiceEngine(this, Tones(), ::sendToPage)

        web.addJavascriptInterface(Bridge(), "PadelNative")

        setContentView(web)
        web.loadUrl("$origin/assets/index.html")

        askForMicrophone()
    }

    // ------------------------------------------------------------------ bridge

    /**
     * What the page may ask for. These arrive on a WebView thread, and nothing
     * here is safe to touch from it, so each one crosses to the main thread.
     */
    private inner class Bridge {
        /** The page is listening: tell it what it missed while it loaded. */
        @JavascriptInterface
        fun ready() = runOnUiThread { voice.publishStatus() }

        @JavascriptInterface
        fun tone(kind: String) = runOnUiThread { voice.tone(kind) }

        @JavascriptInterface
        fun setGrammar(name: String, phrasesJson: String) =
            runOnUiThread { voice.setGrammar(name, phrasesJson) }

        @JavascriptInterface
        fun setVoiceEnabled(on: Boolean) = runOnUiThread { voice.setEnabled(on) }

        /** A log of what was heard is unusable if the only way to relay it is a screenshot. */
        @JavascriptInterface
        fun copy(text: String) = runOnUiThread {
            val clipboard = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("Padel diagnostics", text))
        }
    }

    /** Guarded so a message arriving before the page has loaded is simply dropped. */
    private fun sendToPage(method: String, json: String) {
        runOnUiThread {
            web.evaluateJavascript(
                "window.padelVoice && window.padelVoice.$method(${JSONObject.quote(json)});",
                null,
            )
        }
    }

    // ------------------------------------------------------------- permissions

    /**
     * The microphone is the one permission voice cannot do without. Bluetooth is
     * asked for alongside it because some phones want it before they will name
     * a headset, but a refusal there changes nothing that matters.
     */
    private fun askForMicrophone() {
        val wanted = arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.BLUETOOTH_CONNECT)
        val missing = wanted.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }

        if (missing.isNotEmpty()) requestPermissions(missing.toTypedArray(), PERMISSIONS_REQUEST)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)

        // Refused, start() reports it and the scoreboard carries on by touch.
        if (requestCode == PERMISSIONS_REQUEST && visible) voice.start()
    }

    // ---------------------------------------------------------------- lifecycle

    /**
     * Started and stopped with visibility, not focus: onPause also fires for a
     * permission dialog, and listening has to survive that. Stopping always
     * hands the audio system back, so a call or music afterwards is unaffected.
     */
    override fun onStart() {
        super.onStart()
        visible = true
        voice.start()
    }

    override fun onStop() {
        visible = false
        voice.stop()
        super.onStop()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) goImmersive()
    }

    /** A scoreboard should be all scoreboard. */
    private fun goImmersive() {
        window.setDecorFitsSystemWindows(false)
        window.insetsController?.let {
            it.hide(WindowInsets.Type.systemBars())
            it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }
}
