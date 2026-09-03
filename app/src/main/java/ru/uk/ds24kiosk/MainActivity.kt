package ru.uk.ds24kiosk

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.view.MotionEvent
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebSettings
import android.webkit.WebView
import android.view.WindowManager
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
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
    private val micPermissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            voiceAssistant.startListening()
        } else {
            Toast.makeText(this, R.string.voice_mic_permission_needed, Toast.LENGTH_LONG).show()
        }
    }

    // Автовозврат на главный экран, если планшет оставили на другой вкладке.
    private var lastInteractionAt = SystemClock.elapsedRealtime()
    private var homeUrl: String? = null
    private val idleReturnRunnable = object : Runnable {
        override fun run() {
            checkIdleReturn()
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

    // KioskWebViewClient.Listener
    override fun onMainFrameError() {
        showOfflineOverlay()
    }

    override fun onPageLoaded(webView: WebView, url: String?) {
        hideOfflineOverlay()
        detectLoginScreen(webView)
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

    private fun detectLoginScreen(webView: WebView) {
        val js = "document.body && document.body.innerText && " +
            "document.body.innerText.indexOf('Для входа в личный кабинет') !== -1"
        webView.evaluateJavascript(js) { result ->
            binding.sessionExpiredBadge.visibility = if (result == "true") View.VISIBLE else View.GONE
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
                renderVoiceButtonState(state)
            }

            override fun onError(message: String) {
                Toast.makeText(this@MainActivity, message, Toast.LENGTH_SHORT).show()
            }
        })
        binding.voiceAssistantButton.setOnClickListener {
            val hasPermission = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED
            if (hasPermission) {
                voiceAssistant.startListening()
            } else {
                micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
            }
        }
    }

    private fun renderVoiceButtonState(state: VoiceAssistant.State) {
        val colorRes = when (state) {
            VoiceAssistant.State.LISTENING, VoiceAssistant.State.THINKING -> R.color.pure_brand_tint
            VoiceAssistant.State.IDLE, VoiceAssistant.State.SPEAKING -> R.color.kiosk_accent
        }
        (binding.voiceAssistantButton.background as? GradientDrawable)?.setColor(
            ContextCompat.getColor(this, colorRes),
        )
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
