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

    /** Карточка-итог под репликой консьержа (см. assets/concierge/index.html,
     *  result). Собирается из уже пришедших fields — только то, что
     *  реально известно, без выдуманных номеров заявок/QR. phone —
     *  непусто только для карточки контакта (управляющий/охрана/
     *  диспетчер) — включает кнопку "Позвонить" на экране консьержа. */
    data class ConciergeResult(
        val title: String,
        val tag: String?,
        val lines: List<Pair<String, String>>,
        val phone: String? = null,
    )

    interface Listener {
        fun onStateChanged(state: State)

        /**
         * Вызывается каждый раз, когда ассистент собирается что-то
         * сказать (до начала озвучки) — текст для реплики на экране
         * консьержа. options — короткие кнопки-подсказки (2-4 варианта),
         * не null только для "ask"-вопросов с явным небольшим набором
         * вариантов (см. RESPONSE_SCHEMA.options в backend/src/prompt.js);
         * для всех остальных случаев null. result — карточка-итог,
         * непустая только сразу после "fill" (заказ подготовлен).
         */
        fun onAssistantSaid(text: String, options: List<String>?, result: ConciergeResult?)

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
            listener.onAssistantSaid(greeting, null, null)
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
        // "УК Хоум" пишем как "Ука Хоум" — иначе русский голос читает
        // аббревиатуру по буквам ("у-ка"), а так звучит одним словом.
        // Запятая перед "Ука Хоум" — без неё голос сливал конец слова
        // "ассистент" с началом "Ука" (слышалось как "кахоум"). "Подскажите,"
        // перед "как я могу..." — без вводного слова ударение уходило на
        // "могу" вместо "как"; сравнивалось на слух через GET /tts.
        return "$timeOfDay! Я голосовой ассистент, Ука Хоум. Подскажите, как я могу к вам обращаться?"
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
            // По умолчанию распознаватель обрывает запись при паузе
            // ~1 сек — этого мало, когда диктуют длинный госномер по
            // буквам/цифрам с естественными паузами между группами
            // (реальный случай: обрезало номер машины на середине).
            // Даём больше времени на паузы и на саму фразу.
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 3000L)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 3000L)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 15000L)
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

    /**
     * Вызывается при тапе по кнопке-подсказке (см. Listener.onAssistantSaid
     * options) — ведёт себя ровно так же, как если бы житель сказал этот
     * же текст вслух: та же history/knownFields, тот же путь на backend.
     * Если микрофон в этот момент как раз слушает — останавливаем его,
     * чтобы не словить одновременно и тап, и распознанную речь поверх.
     */
    fun submitQuickReply(text: String) {
        recognizer?.stopListening()
        sendTranscript(text)
    }

    /**
     * Житель вручную закрыл экран консьержа ("Назад") посреди разговора —
     * останавливаем всё, что ещё звучит/слушает, и сбрасываем сессию
     * полностью (endSession), чтобы следующее открытие начиналось с
     * приветствия, а не с обрывка прошлого разговора.
     */
    fun cancel() {
        recognizer?.stopListening()
        recognizer?.cancel()
        tts?.stop()
        try {
            mediaPlayer?.stop()
        } catch (_: Exception) {
            // Мог быть ещё не подготовлен/уже остановлен — не критично.
        }
        mediaPlayer?.release()
        mediaPlayer = null
        endSession()
        setState(State.IDLE)
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
                val options = response.optNullableStringList("options")
                history.add("assistant" to question)
                listener.onAssistantSaid(question, options, null)
                speak(question, UTTERANCE_ASK)
            }
            "fill" -> {
                val say = response.optNullableString("say", "Готово, проверьте форму")
                val fields = response.optJSONObject("fields") ?: JSONObject()
                val action = response.optString("action")
                fillForm(action, fields)
                val result = buildResultFromFields(fields, action)
                // Не endSession() — дело сделано, но разговор продолжается:
                // после этой фразы ассистент сам спросит "ещё чем-то
                // помочь?" (см. onSpeechFinished/askIfAnythingElse), не
                // прощаясь молча.
                softResetForFollowUp()
                listener.onAssistantSaid(say, null, result)
                speak(say, UTTERANCE_FILL_DONE)
            }
            "error" -> {
                val message = response.optNullableString("message", "Не получилось разобрать запрос")
                endSession()
                listener.onAssistantSaid(message, null, null)
                speak(message, UTTERANCE_FINAL)
            }
            "info" -> {
                // Справочный ответ (где кофе/аптека и т.п.) — тоже не
                // конец разговора, а законченный маленький "запрос-ответ"
                // — так же ведёт к "ещё чем-то помочь?", как и "fill".
                // Отдельный случай — контакт (управляющий/охрана/
                // диспетчер, см. CONTACT_DIRECTORY в backend/src/prompt.js):
                // если модель прислала phone, показываем карточку с
                // кнопкой "Позвонить" вместо обычного текстового ответа.
                val say = response.optNullableString("say", "")
                val result = buildContactResult(response)
                softResetForFollowUp()
                listener.onAssistantSaid(say, null, result)
                speak(say, UTTERANCE_FILL_DONE)
            }
            "bye" -> {
                // Житель отказался продолжать разговор (см. byeRule в
                // backend/src/prompt.js) — прощание считаем локально по
                // времени на устройстве, а не доверяем модели его
                // придумывать; она и не пытается, message/say тут null.
                val farewell = buildFarewell()
                endSession()
                listener.onAssistantSaid(farewell, null, null)
                speak(farewell, UTTERANCE_FINAL)
            }
            else -> {
                endSession()
                val fallback = "Что-то пошло не так, попробуйте ещё раз"
                listener.onAssistantSaid(fallback, null, null)
                speak(fallback, UTTERANCE_FINAL)
            }
        }
    }

    /**
     * Карточка-итог для экрана консьержа сразу после "fill" — только
     * реально пришедшие поля (Госномер/Машиноместо/Гость/Апартамент/
     * категория заявки), без выдуманных номеров заявок или QR: наша
     * система не выдаёт ни то, ни другое, форму по-прежнему заполняет и
     * отправляет житель сам на сайте.
     */
    private fun buildResultFromFields(fields: JSONObject, action: String): ConciergeResult? {
        val lines = mutableListOf<Pair<String, String>>()
        fields.optNullableStringOrNull("plateNumber")?.let { lines.add("Госномер" to it) }
        fields.optNullableStringOrNull("parkingSpotNumber")?.let { lines.add("Машиноместо" to it) }
        fields.optNullableStringOrNull("guestName")?.let { lines.add("Гость" to it) }
        fields.optNullableStringOrNull("destinationApartment")?.let { lines.add("Апартамент" to it) }
        fields.optNullableStringOrNull("serviceCategory")?.let { lines.add("Категория" to it) }
        fields.optNullableStringOrNull("serviceQuantity")?.let { lines.add("Количество мешков" to it) }
        if (lines.isEmpty()) return null
        val title = when (action) {
            "order_car_pass" -> "Пропуск на машину"
            "order_walkin_pass" -> "Пропуск для гостя"
            "order_service_trash_removal" -> "Вывоз мусора"
            else -> "Готово"
        }
        return ConciergeResult(title, null, lines)
    }

    /**
     * Карточка контакта (управляющий/охрана/охрана паркинга/диспетчер) —
     * непусто, только когда backend вернул top-level "phone" (см.
     * CONTACT_DIRECTORY + contactsRule в backend/src/prompt.js). Номер и
     * имя/роль читаются жителю голосом через "say" как обычно — карточка
     * с кнопкой "Позвонить" просто избавляет от необходимости запоминать
     * номер на слух.
     */
    private fun buildContactResult(response: JSONObject): ConciergeResult? {
        val phone = response.optNullableStringOrNull("phone") ?: return null
        val role = response.optNullableStringOrNull("contactRole")
        val name = response.optNullableStringOrNull("contactName")
        val lines = mutableListOf<Pair<String, String>>()
        name?.let { lines.add("Имя" to it) }
        lines.add("Телефон" to phone)
        return ConciergeResult(title = role ?: "Контакт", tag = null, lines = lines, phone = phone)
    }

    private fun buildFarewell(): String {
        val hour = Calendar.getInstance().get(Calendar.HOUR_OF_DAY)
        return when (hour) {
            in 5..17 -> "Хорошего дня!"
            in 18..22 -> "Приятного вечера!"
            else -> "Доброй ночи!"
        }
    }

    /**
     * Спрашивает, нужна ли ещё помощь, вместо того чтобы молча уйти в
     * IDLE после fill/info — вызывается из onSpeechFinished(UTTERANCE_FILL_DONE).
     * Вопрос добавляется в history сам (как и обычные "ask"), чтобы
     * backend видел в контексте, что именно спросили — от этого зависит,
     * распознает ли модель следующий ответ жителя как настоящий отказ
     * от разговора (byeRule) или как обычный новый запрос.
     */
    private fun askIfAnythingElse() {
        val question = "Могу ещё чем-то помочь?"
        history.add("assistant" to question)
        listener.onAssistantSaid(question, DEFAULT_FOLLOWUP_OPTIONS, null)
        speak(question, UTTERANCE_ASK)
    }

    /** Разговор завершён — следующее нажатие кнопки снова начнётся с приветствия. */
    private fun endSession() {
        history.clear()
        knownFields = JSONObject()
        hasGreeted = false
    }

    /**
     * "Мягкий" сброс после успешно завершённого дела (fill/info) — в
     * отличие от endSession(), НЕ сбрасывает hasGreeted (не здороваемся
     * заново) и сохраняет уже известное имя жителя, но чистит все
     * транзакционные поля прошлого пропуска/заявки, чтобы модель не
     * унаследовала их в следующей, никак не связанной просьбе.
     */
    private fun softResetForFollowUp() {
        val residentName = knownFields.optNullableString("residentName", "")
        knownFields = JSONObject().apply {
            if (residentName.isNotBlank()) put("residentName", residentName)
        }
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

    /** Как optNullableString, но без дефолта — null, если поля нет,
     *  оно JSON null, или пустая строка (для карточки-результата пустых
     *  строк быть не должно). */
    private fun JSONObject.optNullableStringOrNull(key: String): String? {
        if (!has(key) || isNull(key)) return null
        val value = optString(key, "")
        return value.ifBlank { null }
    }

    /** options — либо JSON null, либо массив строк; отсутствие ключа
     *  (старые ответы сервера до добавления этого поля) тоже null. */
    private fun JSONObject.optNullableStringList(key: String): List<String>? {
        if (!has(key) || isNull(key)) return null
        val array = optJSONArray(key) ?: return null
        return (0 until array.length()).mapNotNull { array.optString(it, null) }
    }

    private fun fillForm(action: String, fields: JSONObject) {
        val jsFunction = when (action) {
            "order_walkin_pass" -> "fillWalkinPass"
            "order_service_trash_removal" -> "fillServiceTrashRemoval"
            else -> "fillCarPass"
        }
        webView.evaluateJavascript(
            "window.__ds24Voice && window.__ds24Voice.$jsFunction($fields);",
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
        when (utteranceId) {
            UTTERANCE_ASK, UTTERANCE_GREETING -> startListening()
            UTTERANCE_FILL_DONE -> askIfAnythingElse()
            else -> setState(State.IDLE)
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

        // Отдельный (не UTTERANCE_FINAL) id для фразы после успешного
        // fill/info — по нему onSpeechFinished понимает, что нужно не
        // уходить в IDLE молча, а спросить "ещё чем-то помочь?" и снова
        // слушать (см. askIfAnythingElse). UTTERANCE_FINAL остаётся для
        // настоящего конца разговора — ошибки и явное прощание (bye).
        private const val UTTERANCE_FILL_DONE = "ds24_fill_done"
        private const val TIMEOUT_MS = 10_000

        // Те же варианты, что и в самом первом открытом вопросе "чем могу
        // помочь" (см. backend/src/prompt.js) — отказаться можно голосом
        // ("нет, спасибо" и т.п.), отдельная кнопка-отказ не нужна.
        private val DEFAULT_FOLLOWUP_OPTIONS = listOf("Заказать пропуск", "Оформить заявку", "Про заведения в комплексе")

        // Собственный сервер (не Cloudflare — из России без VPN не всегда
        // стабильно доступен), см. /backend/README.md.
        private const val BACKEND_URL = "https://d24-voice.infoseledka.ru/assist"
        private const val TTS_URL = "https://d24-voice.infoseledka.ru/tts"
    }
}
