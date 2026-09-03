const ENDPOINT = 'https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize';
const DEFAULT_VOICE = 'jane';

/**
 * Синтез речи через Yandex SpeechKit — заметно естественнее и по
 * умолчанию женский голос ("jane"), в отличие от штатного Android TTS,
 * качество которого сильно зависит от устройства. Тот же ключ/folder,
 * что и для YandexGPT (см. providers/yandexgpt.js) — SpeechKit и AI
 * Studio в одном облаке.
 *
 * Возвращает бинарные байты аудио (OggOpus) — Android-приложение играет
 * их через MediaPlayer, с откатом на локальный TTS, если этот запрос
 * не удался (сеть, сервис недоступен и т.п.).
 */
export async function synthesizeSpeech({ text, env }) {
    const apiKey = env.YANDEX_API_KEY;
    const folderId = env.YANDEX_FOLDER_ID;
    if (!apiKey || !folderId) {
        throw new Error('YANDEX_API_KEY / YANDEX_FOLDER_ID is not configured');
    }
    const voice = env.YANDEX_TTS_VOICE || DEFAULT_VOICE;

    const params = new URLSearchParams({
        text,
        lang: 'ru-RU',
        voice,
        format: 'oggopus',
        folderId,
    });

    const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
            authorization: `Api-Key ${apiKey}`,
            'content-type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Yandex TTS error ${res.status}: ${errText.slice(0, 300)}`);
    }

    return Buffer.from(await res.arrayBuffer());
}
