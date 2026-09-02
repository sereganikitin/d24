package ru.uk.ds24kiosk.webview

import android.webkit.WebChromeClient

/**
 * Стандартный WebChromeClient. Отдельный класс — точка расширения на
 * будущее (например, обработка permission-запросов камеры/микрофона,
 * если голосовой агент будет слушать через сам сайт, а не нативно).
 */
class KioskWebChromeClient : WebChromeClient()
