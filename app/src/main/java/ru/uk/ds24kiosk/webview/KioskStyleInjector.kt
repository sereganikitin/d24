package ru.uk.ds24kiosk.webview

import android.content.Context
import android.util.Base64
import android.util.Log
import android.webkit.WebView
import java.net.HttpURLConnection
import java.net.URL

/**
 * Внедряет кастомные CSS/JS поверх страницы из lk.purehome.ru — точка
 * "перевёрстки" чужого сайта под киоск (укрупнить шрифты/кнопки, сжать
 * главный экран, чтобы влезал без прокрутки, перекрасить в бренд-палитру
 * и т.п.).
 *
 * Правки лежат отдельными файлами (kiosk-inject.css / kiosk-inject.js),
 * и на каждой загрузке страницы сначала пробуем скачать их свежую
 * версию с GitHub (raw-файл из репозитория проекта) — так правки стилей
 * применяются сразу на всех установленных киосках без пересборки и
 * переустановки APK. Если сети нет или репозиторий недоступен (например,
 * с этой сети заблокирован raw.githubusercontent.com) — используем
 * копию, зашитую в assets/ при сборке, так что оформление не пропадает
 * совсем, просто не обновляется мгновенно.
 */
object KioskStyleInjector {

    private const val TAG = "KioskStyleInjector"

    private const val CSS_ASSET = "kiosk-inject.css"
    private const val JS_ASSET = "kiosk-inject.js"

    // Поменяется, если репозиторий/ветка/путь к файлам изменятся.
    private const val REMOTE_BASE =
        "https://raw.githubusercontent.com/sereganikitin/d24/main/app/src/main/assets/"
    private const val FETCH_TIMEOUT_MS = 3000

    fun injectAll(context: Context, webView: WebView) {
        loadContent(context, webView, CSS_ASSET) { css -> injectCss(webView, css) }
        loadContent(context, webView, JS_ASSET) { js -> webView.evaluateJavascript(js, null) }
    }

    /** Сеть — в фоновом потоке, применение к WebView — обратно на главном. */
    private fun loadContent(context: Context, webView: WebView, assetName: String, onReady: (String) -> Unit) {
        Thread {
            val content = fetchRemote(assetName) ?: readAsset(context, assetName)
            if (content != null) {
                webView.post { onReady(content) }
            }
        }.start()
    }

    private fun injectCss(webView: WebView, css: String) {
        val encoded = Base64.encodeToString(css.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
        val js = """
            (function() {
                var id = 'ds24-kiosk-style';
                var existing = document.getElementById(id);
                if (existing) existing.remove();
                var style = document.createElement('style');
                style.id = id;
                style.type = 'text/css';
                style.appendChild(document.createTextNode(atob('$encoded')));
                document.head.appendChild(style);
            })();
        """.trimIndent()
        webView.evaluateJavascript(js, null)
    }

    private fun fetchRemote(assetName: String): String? = try {
        val connection = URL(REMOTE_BASE + assetName).openConnection() as HttpURLConnection
        connection.connectTimeout = FETCH_TIMEOUT_MS
        connection.readTimeout = FETCH_TIMEOUT_MS
        connection.requestMethod = "GET"
        try {
            if (connection.responseCode == HttpURLConnection.HTTP_OK) {
                connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            } else {
                Log.w(TAG, "Remote $assetName returned HTTP ${connection.responseCode}, using bundled copy")
                null
            }
        } finally {
            connection.disconnect()
        }
    } catch (e: Exception) {
        Log.w(TAG, "Remote $assetName unavailable (${e.message}), using bundled copy")
        null
    }

    private fun readAsset(context: Context, name: String): String? = try {
        context.assets.open(name).bufferedReader(Charsets.UTF_8).use { it.readText() }
    } catch (_: Exception) {
        null
    }
}
