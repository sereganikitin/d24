package ru.uk.ds24kiosk.webview

import android.content.Context
import android.util.Base64
import android.webkit.WebView

/**
 * Внедряет кастомный CSS поверх страницы из lk.purehome.ru — точка
 * "перевёрстки" чужого сайта под киоск (укрупнить шрифты/кнопки,
 * скрыть/переставить конкретные блоки). CSS лежит отдельным файлом в
 * assets/kiosk-inject.css, чтобы его можно было править без пересборки
 * логики. Base64 используется, чтобы не думать об экранировании кавычек
 * и переносов строк при передаче содержимого в JS.
 */
object KioskStyleInjector {

    private const val ASSET_NAME = "kiosk-inject.css"

    fun inject(context: Context, webView: WebView) {
        val css = readCss(context) ?: return
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

    private fun readCss(context: Context): String? = try {
        context.assets.open(ASSET_NAME).bufferedReader(Charsets.UTF_8).use { it.readText() }
    } catch (_: Exception) {
        null
    }
}
