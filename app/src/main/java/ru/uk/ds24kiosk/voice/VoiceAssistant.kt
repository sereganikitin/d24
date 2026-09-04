package ru.uk.ds24kiosk.voice

import android.content.Context
import android.content.Intent
import android.media.MediaPlayer
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.Calendar
import java.util.Locale

/**
 * Голосовой помощник для заказа гостевого пропуска на машину (первый
 * пилотный сценарий). Слушает по нажатию кнопки (не всегда включённый
 * микрофон — в шумном лобби это и приватнее, и надёжнее), распознаёт
 * речь и синтезирует ответ на месте (штатные Android API, без сторонних
 * SDK), а "мозги" — backend-прокси (см. /backend в репозитории), у
 * которого свой контракт: {"type":"ask"|"fill"|"error", ...}.
 *
 * Помощник только заполняет форму через window.__ds24Voice.fillCarPass
 * (см. kiosk-inject.js) — кнопку "Заказать" всегда нажимает житель сам.
 */
class VoiceAssistant(
    private val context: Context,
    private val webView: WebView,
    private val listener: Listener,
) {
    enum class State { IDLE, LISTENING, THINKING, SPEAKING }

    interface Listener {
        fun onStateChanged(state: State)
        fun onError(message: String)

        /**
         * Прямой SpeechRecognizer недоступен на устройстве (нет
         * встроенного распознавания — так бывает на прошивках без
         * штатного приложения "Google"/Speech Services). Пробуем
         * запасной путь — системный экран распознавания через Intent;
         * его может запустить только Activity, поэтому просим
         * MainActivity сделать startActivityForResult и вернуть текст
         * через onExternalRecognitionResult.
         */
        fun onNeedExternalRecognition(intent: Intent)
    }

    private var recognizer: SpeechRecognizer? = null
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var mediaPlayer: MediaPlayer? = null
    private val history = mutableListOf<Pair<String, String>>() // role to text

    // Поля пропуска, уже подтверждённые на предыдущих шагах этого
    // разговора. Отправляются backend'у и он их не даёт модели
    // переписать (сервер и так это форсирует, но раз уж сохраняем —
    // заодно и обновляем локально из каждого ответа). Без этого модель
    // на многошаговом диалоге путала/подменяла уже названные ФИО и
    // госномер — небезопасно для системы, которая выдаёт пропуска.
    private var knownFields = JSONObject()

    // Приветствие говорится один раз в начале разговора (пока не
    // сброшено вместе с history — см. endSession()), а не при каждом
    // нажатии кнопки внутри одного и того же диалога.
    private var hasGreeted = false

    // SpeechRecognizer нужно создавать/трогать с того же потока (обычно
    // главного), а колбэки TTS (UtteranceProgressListener) приходят не
    // гарантированно на главном потоке — поэтому всё, что течёт обратно в
    // startListening()/setState(), явно возвращаем на главный поток.
    private val mainHandler = Handler(Looper.getMainLooper())

    init {
        tts = TextToSpeech(context.applicationContext) { status ->
            ttsReady = status == TextToSpeech.SUCCESS
            tts?.language = Locale("ru", "RU")
        }
        tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {}
            override fun onDone(utteranceId: String?) {
                mainHandler.post {
                    if (utteranceId != null) onSpeechFinished(utteranceId) else setState(State.IDLE)
                }
            }

            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) {
                mainHandler.post { setState(State.IDLE) }
            }
        })
    }

    fun startListening() {
        if (!hasGreeted) {
            hasGreeted = true
            val greeting = buildGreeting()
            history.add("assistant" to greeting)
            speak(greeting, UTTERANCE_GREETING)
            return
        }
        beginRecognition()
    }

    private fun buildGreeting(): String {
        val hour = Calendar.getInstance().get(Calendar.HOUR_OF_DAY)
        val timeOfDay = when (hour) {
            in 5..11 -> "Доброе утро"
            in 12..17 -> "Добрый день"
            in 18..22 -> "Добрый вечер"
            else -> "Доброй ночи"
        }
        // "Pure Home Comfort" пишем кириллицей по звучанию — иначе
        // русский голос читает латиницу побуквенно ("пэ у эр е"),
        // а так получается приемлемое английское произношение названия.
        return "$timeOfDay! Я голосовой ассистент Пьюр Хоум Комфорт. Как я могу к вам обращаться?"
    }

    /**
     * Создаёт и привязывает SpeechRecognizer заранее, ПОКА ещё идёт
     * озвучка вопроса — привязка к системному сервису распознавания не
     * мгновенная, и если делать это только после того, как ассистент
     * замолчал, получается заметная пауза: житель уже отвечает, а
     * микрофон ещё не готов слушать, и приходится повторять. Вызывается
     * из speak() параллельно с проигрыванием звука, чтобы к моменту его
     * окончания распознаватель был уже готов и beginRecognition() только
     * стартовал прослушивание, а не создавал его с нуля.
     */
    private fun prepareRecognizer() {
        if (!SpeechRecognizer.isRecognitionAvailable(context)) return
        recognizer?.destroy()
        val r = SpeechRecognizer.createSpeechRecognizer(context)
        recognizer = r
        r.setRecognitionListener(buildRecognitionListener())
    }

    private fun buildRecognitionListener(): RecognitionListener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {
            setState(State.THINKING)
        }

        override fun onError(error: Int) {
            setState(State.IDLE)
            listener.onError("Не расслышал, попробуйте ещё раз")
        }

        override fun onResults(results: Bundle?) {
            val text = results
                ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                ?.firstOrNull()
            if (text.isNullOrBlank()) {
                setState(State.IDLE)
                return
            }
            sendTranscript(text)
        }

        override fun onPartialResults(partialResults: Bundle?) {}
        override fun onEvent(eventType: Int, params: Bundle?) {}
    }

    private fun beginRecognition() {
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            val fallbackIntent = buildRecognitionIntent()
            if (fallbackIntent.resolveActivity(context.packageManager) != null) {
                setState(State.LISTENING)
                listener.onNeedExternalRecognition(fallbackIntent)
            } else {
                listener.onError("Распознавание речи недоступно на этом устройстве")
            }
            return
        }
        // Обычно уже создан и привязан заранее в prepareRecognizer() —
        // сюда попадаем сразу после того, как замолчал TTS, без задержки
        // на создание/привязку. Пересоздаём только если почему-то не
        // подготовили заранее (подстраховка, не основной путь).
        val r = recognizer ?: SpeechRecognizer.createSpeechRecognizer(context).also {
            it.setRecognitionListener(buildRecognitionListener())
            recognizer = it
        }
        setState(State.LISTENING)
        r.startListening(buildRecognitionIntent())
    }

    private fun buildRecognitionIntent(): Intent =
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, "ru-RU")
        }

    /** Результат системного экрана распознавания — см. onNeedExternalRecognition. */
    fun onExternalRecognitionResult(text: String?) {
        if (text.isNullOrBlank()) {
            setState(State.IDLE)
            listener.onError("Не расслышал, попробуйте ещё раз")
            return
        }
        sendTranscript(text)
    }

    fun release() {
        recognizer?.destroy()
        recognizer = null
        tts?.stop()
        tts?.shutdown()
        tts = null
        mediaPlayer?.release()
        mediaPlayer = null
    }

    private fun sendTranscript(transcript: String) {
        history.add("user" to transcript)
        setState(State.THINKING)
        Thread {
            try {
                val response = callBackend(transcript)
                webView.post { handleResponse(response) }
            } catch (e: Exception) {
                Log.w(TAG, "backend call failed", e)
                webView.post {
                    listener.onError("Не удалось связаться с помощником")
                    setState(State.IDLE)
                }
            }
        }.start()
    }

    private fun callBackend(transcript: String): JSONObject {
        val body = JSONObject().apply {
            put("transcript", transcript)
            put("history", JSONArray().apply {
                history.forEach { (role, text) ->
                    put(JSONObject().apply { put("role", role); put("text", text) })
                }
            })
            put("knownFields", knownFields)
        }
        val connection = URL(BACKEND_URL).openConnection() as HttpURLConnection
        connection.requestMethod = "POST"
        connection.doOutput = true
        connection.connectTimeout = TIMEOUT_MS
        connection.readTimeout = TIMEOUT_MS
        connection.setRequestProperty("content-type", "application/json; charset=utf-8")
        connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
        try {
            val stream = if (connection.responseCode in 200..299) connection.inputStream else connection.errorStream
            val text = stream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            return JSONObject(text)
        } finally {
            connection.disconnect()
        }
    }

    private fun handleResponse(response: JSONObject) {
        response.optJSONObject("fields")?.let { knownFields = it }
        when (response.optString("type")) {
            "ask" -> {
                val question = response.optNullableString("question", "Уточните, пожалуйста")
                history.add("assistant" to question)
                speak(question, UTTERANCE_ASK)
            }
            "fill" -> {
                val say = response.optNullableString("say", "Готово, проверьте форму")
                val fields = response.optJSONObject("fields") ?: JSONObject()
                fillForm(fields)
                endSession()
                speak(say, UTTERANCE_FINAL)
            }
            "error" -> {
                val message = response.optNullableString("message", "Не получилось разобрать запрос")
                endSession()
                speak(message, UTTERANCE_FINAL)
            }
            else -> {
                endSession()
                speak("Что-то пошло не так, попробуйте ещё раз", UTTERANCE_FINAL)
            }
        }
    }

    /** Разговор завершён — следующее нажатие кнопки снова начнётся с приветствия. */
    private fun endSession() {
        history.clear()
        knownFields = JSONObject()
        hasGreeted = false
    }

    /**
     * response_format=json_schema у YandexGPT требует, чтобы все поля
     * были в required — необязательные по смыслу поля модель вместо
     * пропуска возвращает как JSON null. Обычный JSONObject.optString
     * этого не видит: для null-значения has(key) истинно, и возвращается
     * буквальная строка "null", а не наш дефолт — поэтому проверяем
     * isNull() отдельно.
     */
    private fun JSONObject.optNullableString(key: String, default: String): String =
        if (isNull(key)) default else optString(key, default)

    private fun fillForm(fields: JSONObject) {
        webView.evaluateJavascript(
            "window.__ds24Voice && window.__ds24Voice.fillCarPass($fields);",
            null,
        )
    }

    /**
     * Сначала пробуем озвучить через Yandex SpeechKit (backend, /tts) —
     * заметно естественнее и по умолчанию женский голос, в отличие от
     * штатного Android TTS, чьё качество сильно зависит от устройства
     * (см. проверку с телефоном без установленных голосов). Если сеть
     * или сервис недоступны — тихо откатываемся на локальный TTS, чтобы
     * помощник не терял голос совсем.
     */
    private fun speak(text: String, utteranceId: String) {
        setState(State.SPEAKING)
        if (utteranceId == UTTERANCE_GREETING || utteranceId == UTTERANCE_ASK) {
            // После этой фразы мы точно снова начнём слушать — готовим
            // распознаватель прямо сейчас, параллельно с озвучкой,
            // чтобы к её концу не было паузы на инициализацию.
            prepareRecognizer()
        }
        Thread {
            val audioFile = try {
                fetchTtsAudio(text)
            } catch (e: Exception) {
                Log.w(TAG, "Cloud TTS unavailable (${e.message}), falling back to on-device", e)
                null
            }
            webView.post {
                if (audioFile != null) {
                    playAudioFile(audioFile, utteranceId, text)
                } else {
                    speakOnDevice(text, utteranceId)
                }
            }
        }.start()
    }

    private fun fetchTtsAudio(text: String): File {
        val connection = URL(TTS_URL).openConnection() as HttpURLConnection
        connection.requestMethod = "POST"
        connection.doOutput = true
        connection.connectTimeout = TIMEOUT_MS
        connection.readTimeout = TIMEOUT_MS
        connection.setRequestProperty("content-type", "application/json; charset=utf-8")
        val body = JSONObject().put("text", text)
        connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
        try {
            if (connection.responseCode !in 200..299) {
                error("HTTP ${connection.responseCode}")
            }
            val file = File.createTempFile("ds24_tts_", ".ogg", context.cacheDir)
            connection.inputStream.use { input ->
                file.outputStream().use { output -> input.copyTo(output) }
            }
            return file
        } finally {
            connection.disconnect()
        }
    }

    private fun playAudioFile(file: File, utteranceId: String, fallbackText: String) {
        mediaPlayer?.release()
        val mp = MediaPlayer()
        mediaPlayer = mp
        mp.setOnPreparedListener { it.start() }
        mp.setOnCompletionListener {
            cleanupPlayer(it, file)
            onSpeechFinished(utteranceId)
        }
        mp.setOnErrorListener { player, _, _ ->
            cleanupPlayer(player, file)
            speakOnDevice(fallbackText, utteranceId)
            true
        }
        try {
            mp.setDataSource(file.absolutePath)
            mp.prepareAsync()
        } catch (e: Exception) {
            Log.w(TAG, "Failed to play cloud TTS audio, falling back to on-device", e)
            cleanupPlayer(mp, file)
            speakOnDevice(fallbackText, utteranceId)
        }
    }

    private fun cleanupPlayer(mp: MediaPlayer, file: File) {
        mp.release()
        if (mediaPlayer === mp) mediaPlayer = null
        file.delete()
    }

    private fun speakOnDevice(text: String, utteranceId: String) {
        if (ttsReady) {
            tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId)
        } else {
            // TTS не готов (например, на устройстве нет русского голоса) —
            // не блокируем сценарий молча, возвращаемся в ожидание.
            setState(State.IDLE)
        }
    }

    private fun onSpeechFinished(utteranceId: String) {
        if (utteranceId == UTTERANCE_ASK || utteranceId == UTTERANCE_GREETING) {
            startListening()
        } else {
            setState(State.IDLE)
        }
    }

    private fun setState(state: State) {
        listener.onStateChanged(state)
    }

    companion object {
        private const val TAG = "VoiceAssistant"
        private const val UTTERANCE_GREETING = "ds24_greeting"
        private const val UTTERANCE_ASK = "ds24_ask"
        private const val UTTERANCE_FINAL = "ds24_final"
        private const val TIMEOUT_MS = 10_000

        // Собственный сервер (не Cloudflare — из России без VPN не всегда
        // стабильно доступен), см. /backend/README.md.
        private const val BACKEND_URL = "https://d24-voice.infoseledka.ru/assist"
        private const val TTS_URL = "https://d24-voice.infoseledka.ru/tts"
    }
}
