package com.norom.padelaudio

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.pm.ApplicationInfo
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

/**
 * The scoreboard, wrapped so it can listen.
 *
 * Everything that keeps score — the rules, undo, persistence, the display — is
 * the web app, served from the APK's assets. The native side exists for what a
 * page cannot do: keep the screen on, and (from the voice milestone on) record
 * from the earbud microphone and recognise speech on the device.
 */
class MainActivity : Activity() {

    private lateinit var web: WebView

    /** ES modules are blocked on file://, so assets are served over an origin. */
    private val origin = "https://appassets.androidplatform.net"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

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

        // Lets the diagnostics screen put its report on the clipboard. A log of
        // what was heard is unusable if the only way to relay it is a screenshot.
        web.addJavascriptInterface(
            object {
                @JavascriptInterface
                fun copy(text: String) {
                    val clipboard = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
                    clipboard.setPrimaryClip(ClipData.newPlainText("Padel diagnostics", text))
                }
            },
            "PadelNative",
        )

        setContentView(web)
        web.loadUrl("$origin/assets/index.html")
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
