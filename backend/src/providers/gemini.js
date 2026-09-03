import { buildContents, buildSystemPrompt, RESPONSE_SCHEMA } from '../prompt.js';

const DEFAULT_MODEL = 'gemini-2.5-flash';

/**
 * Вызывает Gemini API с structured output (responseSchema), чтобы ответ
 * гарантированно был валидным JSON по контракту из prompt.js.
 * Имя модели в GEMINI_MODEL (env var, см. wrangler.toml) — если Google
 * его переименует/уберёт, править тут не нужно, только переменную.
 */
export async function callGemini({ transcript, history, env }) {
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is not configured (wrangler secret put GEMINI_API_KEY)');
    const model = env.GEMINI_MODEL || DEFAULT_MODEL;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const payload = {
        systemInstruction: { parts: [{ text: buildSystemPrompt() }] },
        contents: buildContents(transcript, history),
        generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
            temperature: 0.2,
        },
    };

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 300)}`);
    }

    const data = await res.json();
    const text = data && data.candidates && data.candidates[0]
        && data.candidates[0].content && data.candidates[0].content.parts
        && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
    if (!text) throw new Error('Gemini returned no content');

    try {
        return JSON.parse(text);
    } catch {
        throw new Error('Gemini returned non-JSON content: ' + text.slice(0, 200));
    }
}
