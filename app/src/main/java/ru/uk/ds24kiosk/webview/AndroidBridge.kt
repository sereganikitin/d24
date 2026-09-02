package ru.uk.ds24kiosk.webview

import android.webkit.JavascriptInterface

/**
 * Мост между WebView и нативным кодом (window.DS24Kiosk в JS).
 * Сейчас не используется страницей — точка расширения под будущего
 * голосового ИИ-агента: нативный STT-модуль сможет вызывать
 * webView.evaluateJavascript(...) для навигации/сабмита форм по команде,
 * а страница (если потребуется) — звать методы отсюда.
 */
class AndroidBridge {

    @JavascriptInterface
    fun ping(): String = "ok"
}
