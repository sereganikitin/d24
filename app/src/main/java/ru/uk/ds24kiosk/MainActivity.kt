package ru.uk.ds24kiosk

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.speech.RecognizerIntent
import android.view.MotionEvent
import android.view.View
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.view.WindowManager
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import org.json.JSONArray
import org.json.JSONObject
import ru.uk.ds24kiosk.databinding.ActivityMainBinding
import ru.uk.ds24kiosk.voice.VoiceAssistant
import ru.uk.ds24kiosk.webview.AndroidBridge
import ru.uk.ds24kiosk.webview.KioskStyleInjector
import ru.uk.ds24kiosk.webview.KioskWebChromeClient
import ru.uk.ds24kiosk.webview.KioskWebViewClient

class MainActivity : AppCompatActivity(), KioskWebViewClient.Listener {

    private lateinit var binding: ActivityMainBinding
    private val mainHandler = Handler(Looper.getMainLooper())

    private var retrySeconds = OFFLINE_RETRY_SECONDS
    private var retryRunnable: Runnable? = null
    private var longPressRunnable: Runnable? = null

    private lateinit var voiceAssistant: VoiceAssistant

    // Кнопки-подсказки, показанные последним render() — по индексу из
    // ConciergeBridge.onOption() нужно понять, какой именно текст тапнул
    // житель (в HTML лежат только label/sub, а submitQuickReply() ждёт
    // ровно ту же строку, что ушла бы голосом).
    private var lastConciergeOptions: List<String> = emptyList()

    // Начинаем с предположения "не на экране логина" — оно же
    // изначальное состояние консьержа (открыт по умолчанию, см.
    // setupConciergeWebView). Если самая первая настоящая проверка
    // (refreshAuthState) всё же найдёт экран логина — сработает переход
    // false→true и консьерж корректно спрячется, открыв его жителю.
    private var wasOnLoginScreen = false

    private val micPermissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            voiceAssistant.startListening()
        } else {
            Toast.makeText(this, R.string.voice_mic_permission_needed, Toast.LENGTH_LONG).show()
        }
    }

    // Запасной способ распознавания речи — системный экран (не наш
    // фирменный микрофон), для устройств, где нет встроенного
    // SpeechRecognizer. См. VoiceAssistant.Listener.onNeedExternalRecognition.
    private val externalRecognitionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val text = result.data
            ?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
            ?.firstOrNull()
        voiceAssistant.onExternalRecognitionResult(text)
    }

    // Автовозврат на главный экран, если планшет оставили на другой вкладке.
    private var lastInteractionAt = SystemClock.elapsedRealtime()
    private var homeUrl: String? = null
    private val idleReturnRunnable = object : Runnable {
        override fun run() {
            checkIdleReturn()
            refreshAuthState(binding.webView)
            mainHandler.postDelayed(this, IDLE_CHECK_INTERVAL_MS)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (BuildConfig.IS_KIOSK) CrashWatchdog.install(this)

        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        applyImmersiveMode()

        setupWebView()
        setupConciergeWebView()
        setupAdminGesture()
        setupVoiceAssistant()
        mainHandler.postDelayed(idleReturnRunnable, IDLE_CHECK_INTERVAL_MS)

        if (BuildConfig.IS_KIOSK) requestIgnoreBatteryOptimizations()
    }

    override fun onDestroy() {
        super.onDestroy()
        mainHandler.removeCallbacksAndMessages(null)
        if (::voiceAssistant.isInitialized) voiceAssistant.release()
    }

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        lastInteractionAt = SystemClock.elapsedRealtime()
        return super.dispatchTouchEvent(ev)
    }

    /**
     * Если ушли с главного экрана (вкладка "Помещение"/"Обращения"/"Платежи"
     * и т.п.) и минуту никто не трогал экран — возвращаемся на главный.
     * "Главный экран" запоминаем автоматически по первому URL, в пути
     * которого встречается "/main" (это то, что реально отдаёт сайт после
     * входа — см. lk.purehome.ru/<id>/main/category).
     */
    private fun checkIdleReturn() {
        val currentUrl = binding.webView.url ?: return
        if (isHomeUrl(currentUrl)) {
            homeUrl = currentUrl
            return
        }
        val home = homeUrl ?: return
        val idleFor = SystemClock.elapsedRealtime() - lastInteractionAt
        if (idleFor >= IDLE_TIMEOUT_MS) {
            binding.webView.loadUrl(home)
            lastInteractionAt = SystemClock.elapsedRealtime()
        }
    }

    private fun isHomeUrl(url: String): Boolean = url.contains("/main", ignoreCase = true)

    override fun onResume() {
        super.onResume()
        applyImmersiveMode()
        if (BuildConfig.IS_KIOSK) tryStartLockTask()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) applyImmersiveMode()
    }

    @Deprecated("Deprecated in Java", ReplaceWith("super.onBackPressed()"))
    override fun onBackPressed() {
        // В kiosk-сборке выход по Back не даём (и так блокируется Screen
        // Pinning); в dev-сборке — обычное поведение для удобства отладки.
        if (BuildConfig.IS_KIOSK) return
        super.onBackPressed()
    }

    private fun applyImmersiveMode() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val controller = WindowInsetsControllerCompat(window, binding.root)
        controller.hide(WindowInsetsCompat.Type.systemBars())
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }

    private fun setupWebView() {
        val webView = binding.webView
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            loadWithOverviewMode = true
            useWideViewPort = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = false
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, true)
        }
        webView.webViewClient = KioskWebViewClient(this, this)
        webView.webChromeClient = KioskWebChromeClient()
        webView.addJavascriptInterface(AndroidBridge(), "DS24Kiosk")
        webView.loadUrl(getString(R.string.portal_url))
    }

    /**
     * Второй, полностью независимый WebView — полноэкранный голосовой
     * консьерж (assets/concierge/index.html), поверх основного WebView
     * с lk.purehome.ru. Это теперь экран по умолчанию (виден сразу при
     * запуске, ещё до логина/любого тапа) — сайт УК живёт под ним и
     * временно открывается только на шаге проверки заполненной формы
     * (см. onAssistantSaid: result != null → closeConcierge()).
     */
    private fun setupConciergeWebView() {
        val concierge = binding.conciergeWebView
        concierge.settings.javaScriptEnabled = true
        concierge.addJavascriptInterface(ConciergeBridge(), "ConciergeBridge")
        concierge.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String?) {
                renderConciergeIdle()
            }
        }
        concierge.loadUrl("file:///android_asset/concierge/index.html")
        openConcierge()
    }

    private fun openConcierge() {
        binding.conciergeWebView.visibility = View.VISIBLE
    }

    private fun closeConcierge() {
        binding.conciergeWebView.visibility = View.GONE
    }

    /** Стартовый экран консьержа до первого "Говорите" — просто
     *  приглашение поговорить, никакого обращения к backend ещё не было. */
    private fun renderConciergeIdle() {
        binding.conciergeWebView.evaluateJavascript(
            // 2026-09-13: убрано "Скажите «Консьерж» или" — реального
            // распознавания кодового слова нет (нужен отдельный
            // постоянно слушающий движок), а текст обещал то, чего
            // приложение не умеет. По словам заказчика, это не
            // критично без настоящего wake-word, лишь бы текст не вводил
            // в заблуждение.
            "window.DS24Concierge.render({say:'Нажмите «Говорите» — я рядом.'," +
                "hint:'Помощник ждёт обращения', options: null, result: null}); " +
                "window.DS24Concierge.setState('idle');",
            null,
        )
    }

    /**
     * Запускает голосового помощника, сначала убедившись, что есть
     * разрешение на микрофон — раньше эта проверка жила только в
     * клике по внешней кнопке-триггеру, но теперь единственный вход в
     * разговор — кнопка "Говорите" внутри самого консьержа
     * (ConciergeBridge.onMicTap), так что проверка переехала сюда.
     */
    private fun startVoiceAssistant() {
        val hasPermission = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        if (hasPermission) {
            voiceAssistant.startListening()
        } else {
            micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    /**
     * То, что консьерж сейчас говорит/предлагает — текст, кнопки и,
     * после успешного заказа, карточка-итог. Пушится в JS одним вызовом
     * render(); анимация состояния (моргание/рот/индикатор слушания)
     * переключается отдельно, см. onStateChanged → setState в JS.
     */
    private fun renderConcierge(text: String, options: List<String>?, result: VoiceAssistant.ConciergeResult?) {
        lastConciergeOptions = options ?: emptyList()
        val payload = JSONObject().apply {
            put("say", text)
            put(
                "hint",
                if (lastConciergeOptions.isNotEmpty()) "Скажите или выберите вариант ниже" else "Говорите — я слушаю",
            )
            put(
                "options",
                JSONArray().apply {
                    lastConciergeOptions.forEach { label -> put(JSONObject().apply { put("label", label) }) }
                },
            )
            put(
                "result",
                result?.let { r ->
                    JSONObject().apply {
                        put("title", r.title)
                        put("tag", r.tag)
                        put(
                            "lines",
                            JSONArray().apply {
                                r.lines.forEach { (k, v) -> put(JSONObject().apply { put("k", k); put("v", v) }) }
                            },
                        )
                    }
                },
            )
        }
        binding.conciergeWebView.evaluateJavascript("window.DS24Concierge.render($payload)", null)
    }

    /** Мост consierge/index.html → Kotlin. Методы вызываются WebView не
     *  на главном потоке — SpeechRecognizer и работа с View требуют
     *  главный, поэтому везде runOnUiThread. */
    inner class ConciergeBridge {
        @JavascriptInterface
        fun onOption(index: Int) {
            val label = lastConciergeOptions.getOrNull(index) ?: return
            runOnUiThread { voiceAssistant.submitQuickReply(label) }
        }

        @JavascriptInterface
        fun onBack() {
            // cancel() сам сбросит на IDLE, а onStateChanged(IDLE) вернёт
            // консьержа к приглашению (см. setupVoiceAssistant) — сайт
            // тут вообще не при чём, "Назад" всегда остаётся внутри
            // консьержа, а не открывает реальную страницу.
            runOnUiThread { voiceAssistant.cancel() }
        }

        @JavascriptInterface
        fun onMicTap() {
            runOnUiThread { startVoiceAssistant() }
        }
    }

    // KioskWebViewClient.Listener
    override fun onMainFrameError() {
        showOfflineOverlay()
    }

    override fun onPageLoaded(webView: WebView, url: String?) {
        hideOfflineOverlay()
        refreshAuthState(webView)
        KioskStyleInjector.injectAll(this, webView)
    }

    private fun showOfflineOverlay() {
        retrySeconds = OFFLINE_RETRY_SECONDS
        binding.offlineOverlay.visibility = View.VISIBLE
        scheduleRetryTick()
    }

    private fun hideOfflineOverlay() {
        binding.offlineOverlay.visibility = View.GONE
        retryRunnable?.let { mainHandler.removeCallbacks(it) }
        retryRunnable = null
    }

    private fun scheduleRetryTick() {
        binding.offlineRetry.text = getString(R.string.offline_retry, retrySeconds)
        val runnable = Runnable {
            retrySeconds -= 1
            if (retrySeconds <= 0) {
                binding.webView.reload()
            } else {
                scheduleRetryTick()
            }
        }
        retryRunnable = runnable
        mainHandler.postDelayed(runnable, 1000)
    }

    /**
     * Один и тот же признак ("виден ли экран логина") используется для
     * двух вещей: показать бейдж "сессия истекла" и скрыть голосового
     * помощника, пока не залогинились (заполнять форму пропуска до входа
     * всё равно нельзя, а кнопка-микрофон только сбивала бы с толку).
     * Вызывается не только один раз при загрузке страницы, но и
     * периодически (см. idleReturnRunnable) — это SPA, переход от
     * экрана логина к главному после ввода SMS-кода происходит без
     * перезагрузки страницы, обычный onPageLoaded это не поймает.
     */
    private fun refreshAuthState(webView: WebView) {
        val js = "document.body && document.body.innerText && " +
            "document.body.innerText.indexOf('Для входа в личный кабинет') !== -1"
        webView.evaluateJavascript(js) { result ->
            val onLoginScreen = result == "true"
            binding.sessionExpiredBadge.visibility = if (onLoginScreen) View.VISIBLE else View.GONE
            binding.voiceAssistantButton.visibility = if (onLoginScreen) View.GONE else View.VISIBLE
            // Реагируем только на ПЕРЕХОД между экраном логина и обычным
            // состоянием, а не на каждый опрос (idleReturnRunnable тикает
            // раз в 5с) — иначе это же самое openConcierge() спорило бы с
            // намеренным закрытием консьержа на шаге проверки заполненной
            // формы (см. onAssistantSaid), которое тоже держит логин уже
            // пройденным.
            if (onLoginScreen != wasOnLoginScreen) {
                if (onLoginScreen) {
                    if (::voiceAssistant.isInitialized) voiceAssistant.cancel()
                    closeConcierge()
                } else {
                    openConcierge()
                }
                wasOnLoginScreen = onLoginScreen
            }
        }
    }

    private fun setupAdminGesture() {
        binding.adminGestureZone.setOnTouchListener { _, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    val runnable = Runnable { onAdminGestureTriggered() }
                    longPressRunnable = runnable
                    mainHandler.postDelayed(runnable, ADMIN_GESTURE_HOLD_MS)
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    longPressRunnable?.let { mainHandler.removeCallbacks(it) }
                    true
                }
                else -> false
            }
        }
    }

    private fun setupVoiceAssistant() {
        voiceAssistant = VoiceAssistant(this, binding.webView, object : VoiceAssistant.Listener {
            override fun onStateChanged(state: VoiceAssistant.State) {
                if (state == VoiceAssistant.State.IDLE) {
                    // Конец разговора (ошибка/прощание/"Назад") — просто
                    // возвращаем консьержа к начальному приглашению, а не
                    // прячем экран: сайт под ним нужен видимым только на
                    // шаге проверки заполненной формы (см. onAssistantSaid).
                    openConcierge()
                    renderConciergeIdle()
                    // Реальный сайт мог остаться с открытой модалкой/
                    // заполненной формой прошлого разговора (пропуск/
                    // заявка) — перезагружаем его именно тут, на ИСТИННОМ
                    // конце разговора, а не сразу после "fill" (там форму
                    // как раз нужно оставить видимой для проверки). Иначе
                    // следующий разговор начинался бы поверх чужого
                    // "хвоста" с прошлого раза (баг с реального устройства,
                    // 2026-09-13). Сайт сейчас скрыт под консьержем — сброс
                    // не будет заметен жителю.
                    binding.webView.reload()
                } else {
                    val jsState = when (state) {
                        VoiceAssistant.State.LISTENING -> "listening"
                        VoiceAssistant.State.THINKING -> "thinking"
                        VoiceAssistant.State.SPEAKING -> "speaking"
                        VoiceAssistant.State.IDLE -> "idle" // недостижимо в этой ветке, для exhaustiveness
                    }
                    binding.conciergeWebView.evaluateJavascript("window.DS24Concierge.setState('$jsState')", null)
                }
            }

            override fun onAssistantSaid(text: String, options: List<String>?, result: VoiceAssistant.ConciergeResult?) {
                renderConcierge(text, options, result)
                // result непустой ровно один раз — сразу после "fill":
                // прячем консьержа и показываем настоящий сайт с уже
                // заполненной (и теперь тёмной, см. kiosk-inject.js)
                // формой, чтобы житель проверил и сам нажал «Заказать».
                // На следующем шаге ("ещё чем-то помочь?") result снова
                // null, и консьерж сам вернётся поверх сайта.
                if (result != null) closeConcierge() else openConcierge()
            }

            override fun onError(message: String) {
                Toast.makeText(this@MainActivity, message, Toast.LENGTH_SHORT).show()
            }

            override fun onNeedExternalRecognition(intent: Intent) {
                externalRecognitionLauncher.launch(intent)
            }
        })
        // Консьерж теперь виден по умолчанию (см. setupConciergeWebView) —
        // эта маленькая кнопка нужна только на случай, если экран сейчас
        // скрыт (идёт проверка заполненной формы на настоящем сайте, см.
        // onAssistantSaid) и житель хочет вернуться к ассистенту вручную,
        // не дожидаясь автоматического "ещё чем-то помочь?".
        binding.voiceAssistantButton.setOnClickListener { openConcierge() }
    }

    private fun onAdminGestureTriggered() {
        AdminAccessGate.promptPin(this) {
            if (BuildConfig.IS_KIOSK) stopLockTaskIfActive()
            AdminAccessGate.showMenu(
                activity = this,
                onReload = { binding.webView.reload() },
                onResumeKiosk = { if (BuildConfig.IS_KIOSK) tryStartLockTask() },
            )
        }
    }

    private fun tryStartLockTask() {
        try {
            startLockTask()
        } catch (_: Exception) {
            // Screen Pinning недоступен на этом устройстве/уже активен — не критично.
        }
    }

    private fun stopLockTaskIfActive() {
        try {
            stopLockTask()
        } catch (_: Exception) {
            // Не были в lock task — ничего страшного.
        }
    }

    private fun requestIgnoreBatteryOptimizations() {
        try {
            val powerManager = getSystemService(POWER_SERVICE) as PowerManager
            if (!powerManager.isIgnoringBatteryOptimizations(packageName)) {
                val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:$packageName")
                }
                startActivity(intent)
            }
        } catch (_: Exception) {
            // На части прошивок этот intent недоступен — не блокируем запуск киоска.
        }
    }

    companion object {
        private const val OFFLINE_RETRY_SECONDS = 5
        private const val ADMIN_GESTURE_HOLD_MS = 3000L
        private const val IDLE_TIMEOUT_MS = 60_000L
        private const val IDLE_CHECK_INTERVAL_MS = 5_000L
    }
}
