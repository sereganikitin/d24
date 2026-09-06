const ENDPOINT = 'https://searchapi.api.cloud.yandex.net/v2/gen/search';

/**
 * Генеративный поиск Yandex (GenSearch) — для "разумных общих вопросов"
 * не по теме ЖК (погода, маршруты, общие факты и т.п.), которые
 * основной ассистент решает не пытаться придумывать сам, а честно
 * искать. Тот же ключ/folder, что и для YandexGPT/SpeechKit.
 *
 * isAnswerRejected у самого API — встроенная защита от ответа без
 * надёжных источников; в этом случае кидаем ошибку, а не читаем
 * пустой/сомнительный текст вслух в лобби жилого комплекса.
 */
export async function searchAndSummarize({ query, env }) {
    const apiKey = env.YANDEX_API_KEY;
    const folderId = env.YANDEX_FOLDER_ID;
    if (!apiKey || !folderId) {
        throw new Error('YANDEX_API_KEY / YANDEX_FOLDER_ID is not configured');
    }

    const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Api-Key ${apiKey}`,
        },
        body: JSON.stringify({
            messages: [{ content: query, role: 'ROLE_USER' }],
            folderId,
        }),
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Yandex Search API error ${res.status}: ${errText.slice(0, 300)}`);
    }

    const data = await res.json();
    if (data && data.isAnswerRejected) {
        throw new Error('Search API could not find a reliable answer');
    }
    const answer = data && data.message && data.message.content;
    if (!answer) throw new Error('Yandex Search API returned no answer');
    return answer;
}
