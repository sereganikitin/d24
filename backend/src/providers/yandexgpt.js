import { buildOpenAiMessages, buildSystemPrompt, RESPONSE_SCHEMA } from '../prompt.js';

const DEFAULT_MODEL = 'yandexgpt/latest';
const ENDPOINT = 'https://ai.api.cloud.yandex.net/v1/chat/completions';

/**
 * YandexGPT через OpenAI-совместимый слой Yandex AI Studio. Выбран
 * вместо Gemini/Claude, потому что оба недоступны для запросов из
 * России (см. https://ai.google.dev/gemini-api/docs/available-regions
 * и аналогичные ограничения у Anthropic) — а backend физически стоит в
 * России (та же причина, по которой мы ушли с Cloudflare для стороны
 * "киоск → backend", тут та же проблема на стороне "backend → LLM").
 *
 * Ключ и folder id — в AI Studio (aistudio.yandex.ru): создать API-ключ
 * и скопировать folder id (наводкой на имя папки вверху экрана).
 */
export async function callYandexGpt({ transcript, history, env }) {
    const apiKey = env.YANDEX_API_KEY;
    const folderId = env.YANDEX_FOLDER_ID;
    if (!apiKey || !folderId) {
        throw new Error('YANDEX_API_KEY / YANDEX_FOLDER_ID is not configured');
    }
    const modelName = env.YANDEX_MODEL || DEFAULT_MODEL;
    const modelUri = `gpt://${folderId}/${modelName}`;

    const messages = [
        { role: 'system', content: buildSystemPrompt() },
        ...buildOpenAiMessages(transcript, history),
    ];

    const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Api-Key ${apiKey}`,
            'OpenAI-Project': folderId,
        },
        body: JSON.stringify({
            model: modelUri,
            messages,
            temperature: 0.2,
            response_format: {
                type: 'json_schema',
                json_schema: { name: 'assist_response', schema: RESPONSE_SCHEMA },
            },
        }),
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`YandexGPT API error ${res.status}: ${errText.slice(0, 300)}`);
    }

    const data = await res.json();
    const content = data && data.choices && data.choices[0]
        && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error('YandexGPT returned no content');

    try {
        return JSON.parse(content);
    } catch {
        throw new Error('YandexGPT returned non-JSON content: ' + content.slice(0, 200));
    }
}
