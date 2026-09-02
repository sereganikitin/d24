package ru.uk.ds24kiosk.webview

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * WebViewClient для kiosk-режима: держит навигацию внутри WebView, наружу
 * выпускает только нестандартные схемы (tel:, sms:, mailto:), и сообщает
 * хосту о сбоях сети и о возврате на экран логина (истёкшая сессия).
 */
class KioskWebViewClient(
    private val context: Context,
    private val listener: Listener,
) : WebViewClient() {

    interface Listener {
        fun onMainFrameError()
        fun onPageLoaded(webView: WebView, url: String?)
    }

    private val externalSchemes = setOf("tel", "sms", "mailto")

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val scheme = request.url.scheme?.lowercase()
        if (scheme != null && scheme in externalSchemes) {
            openExternally(request.url)
            return true
        }
        // Всё остальное (http/https, в т.ч. возможные редиректы на поддомены
        // авторизации) остаётся внутри WebView.
        return false
    }

    private fun openExternally(uri: Uri) {
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: ActivityNotFoundException) {
            // На киоске может не быть телефонного приложения — просто игнорируем.
        }
    }

    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
        super.onReceivedError(view, request, error)
        if (request.isForMainFrame) {
            listener.onMainFrameError()
        }
    }

    override fun onPageFinished(view: WebView, url: String?) {
        super.onPageFinished(view, url)
        listener.onPageLoaded(view, url)
    }
}
