package ru.uk.ds24kiosk.voice

import android.content.Context
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
import java.net.HttpURLConnection
import java.net.URL
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
    }

    private var recognizer: SpeechRecognizer? = null
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private val history = mutableListOf<Pair<String, String>>() // role to text

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
                    if (utteranceId == UTTERANCE_ASK) {
                        startListening()
                    } else {
                        setState(State.IDLE)
                    }
                }
            }

            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) {
                mainHandler.post { setState(State.IDLE) }
            }
        })
    }

    fun startListening() {
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            listener.onError("Распознавание речи недоступно на этом устройстве")
            return
        }
        recognizer?.destroy()
        val r = SpeechRecognizer.createSpeechRecognizer(context)
        recognizer = r
        r.setRecognitionListener(object : RecognitionListener {
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
        })

        val intent = android.content.Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, "ru-RU")
        }
        setState(State.LISTENING)
        r.startListening(intent)
    }

    fun release() {
        recognizer?.destroy()
        recognizer = null
        tts?.stop()
        tts?.shutdown()
        tts = null
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
        when (response.optString("type")) {
            "ask" -> {
                val question = response.optString("question", "Уточните, пожалуйста")
                history.add("assistant" to question)
                speak(question, UTTERANCE_ASK)
            }
            "fill" -> {
                val say = response.optString("say", "Готово, проверьте форму")
                val fields = response.optJSONObject("fields") ?: JSONObject()
                fillForm(fields)
                history.clear()
                speak(say, UTTERANCE_FINAL)
            }
            "error" -> {
                val message = response.optString("message", "Не получилось разобрать запрос")
                history.clear()
                speak(message, UTTERANCE_FINAL)
            }
            else -> {
                history.clear()
                speak("Что-то пошло не так, попробуйте ещё раз", UTTERANCE_FINAL)
            }
        }
    }

    private fun fillForm(fields: JSONObject) {
        webView.evaluateJavascript(
            "window.__ds24Voice && window.__ds24Voice.fillCarPass($fields);",
            null,
        )
    }

    private fun speak(text: String, utteranceId: String) {
        setState(State.SPEAKING)
        if (ttsReady) {
            tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId)
        } else {
            // TTS не готов (например, на устройстве нет русского голоса) —
            // не блокируем сценарий молча, возвращаемся в ожидание.
            setState(State.IDLE)
        }
    }

    private fun setState(state: State) {
        listener.onStateChanged(state)
    }

    companion object {
        private const val TAG = "VoiceAssistant"
        private const val UTTERANCE_ASK = "ds24_ask"
        private const val UTTERANCE_FINAL = "ds24_final"
        private const val TIMEOUT_MS = 10_000

        // Собственный сервер (не Cloudflare — из России без VPN не всегда
        // стабильно доступен), см. /backend/README.md.
        private const val BACKEND_URL = "https://d24-voice.infoseledka.ru/assist"
    }
}
