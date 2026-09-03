import express from 'express';
import { callGemini } from './providers/gemini.js';
import { callClaude } from './providers/claude.js';
import { callYandexGpt } from './providers/yandexgpt.js';
import { synthesizeSpeech } from './providers/yandex-tts.js';
import { classifyPassTypeByKeywords } from './prompt.js';

/**
 * Прокси между киоском и LLM: держит API-ключ на своей стороне (в
 * Android-приложении ключ светить нельзя), принимает распознанный текст
 * от голосового помощника, возвращает либо уточняющий вопрос, либо
 * данные для заполнения формы пропуска. Контракт запроса/ответа — см.
 * README.md.
 *
 * Изначально задумывался как Cloudflare Worker, но у Cloudflare бывают
 * перебои с доступностью в России без VPN — переехал на свой сервер
 * (обычный Node/Express за nginx, как соседние сервисы на этой же
 * машине). providers/*.js и prompt.js от хостинга не зависят.
 *
 * Провайдер по умолчанию — YandexGPT, не Gemini: у Gemini (и, судя по
 * всему, у Claude) нет России в списке доступных регионов API, а этот
 * backend физически стоит в России — запросы бы просто отклонялись.
 */
const PROVIDERS = {
    yandexgpt: callYandexGpt,
    gemini: callGemini,
    claude: callClaude,
};

const app = express();
app.use(express.json());

app.post('/assist', async (req, res) => {
    const transcript = String((req.body && req.body.transcript) || '').trim();
    if (!transcript) {
        return res.status(400).json({ type: 'error', message: 'transcript is required' });
    }
    const history = Array.isArray(req.body && req.body.history) ? req.body.history : [];

    // knownFields — то, что клиент уже подтвердил на предыдущих шагах
    // этого разговора; сервер не даёт модели это переписать (см.
    // enforceKnownFields в prompt.js — там же объяснение, почему это
    // важно). passType по возможности определяем разбором ключевых слов
    // ещё до обращения к модели — надёжнее, чем полагаться на LLM.
    const knownFields = (req.body && req.body.knownFields && typeof req.body.knownFields === 'object')
        ? { ...req.body.knownFields }
        : {};
    if (!knownFields.passType) {
        const guessed = classifyPassTypeByKeywords(transcript);
        if (guessed) knownFields.passType = guessed;
    }

    const providerName = String(process.env.LLM_PROVIDER || 'yandexgpt').toLowerCase();
    const call = PROVIDERS[providerName] || callYandexGpt;
    const env = process.env;

    try {
        const result = await call({ transcript, history, knownFields, env });
        res.json(result);
    } catch (err) {
        console.error('assist error:', err);
        res.status(502).json({ type: 'error', message: String((err && err.message) || err) });
    }
});

app.post('/tts', async (req, res) => {
    const text = String((req.body && req.body.text) || '').trim();
    if (!text) {
        return res.status(400).json({ error: 'text is required' });
    }
    try {
        const audio = await synthesizeSpeech({ text, env: process.env });
        res.set('content-type', 'audio/ogg');
        res.send(audio);
    } catch (err) {
        console.error('tts error:', err);
        res.status(502).json({ error: String((err && err.message) || err) });
    }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT) || 3011;
app.listen(port, '127.0.0.1', () => {
    console.log(`d24-voice-assist listening on 127.0.0.1:${port}`);
});
