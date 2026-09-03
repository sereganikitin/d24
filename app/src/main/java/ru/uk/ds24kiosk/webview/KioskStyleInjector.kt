package ru.uk.ds24kiosk.webview

import android.content.Context
import android.util.Base64
import android.webkit.WebView

/**
 * Внедряет кастомные CSS/JS поверх страницы из lk.purehome.ru — точка
 * "перевёрстки" чужого сайта под киоск (укрупнить шрифты/кнопки, сжать
 * главный экран, чтобы влезал без прокрутки, скрыть/переставить блоки).
 * Правки лежат отдельными файлами в assets/, чтобы их можно было менять
 * без пересборки Kotlin-кода:
 *  - kiosk-inject.css — чистые CSS-правки, вставляются как <style>.
 *  - kiosk-inject.js — JS-правки там, где одного CSS не хватает
 *    (например, нужно найти секцию по тексту заголовка).
 */
object KioskStyleInjector {

    private const val CSS_ASSET = "kiosk-inject.css"
    private const val JS_ASSET = "kiosk-inject.js"

    fun injectAll(context: Context, webView: WebView) {
        injectCss(context, webView)
        injectLayoutTweaks(context, webView)
    }

    private fun injectCss(context: Context, webView: WebView) {
        val css = readAsset(context, CSS_ASSET) ?: return
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

    private fun injectLayoutTweaks(context: Context, webView: WebView) {
        val js = readAsset(context, JS_ASSET) ?: return
        webView.evaluateJavascript(js, null)
    }

    private fun readAsset(context: Context, name: String): String? = try {
        context.assets.open(name).bufferedReader(Charsets.UTF_8).use { it.readText() }
    } catch (_: Exception) {
        null
    }
}
