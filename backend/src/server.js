import express from 'express';
import { callGemini } from './providers/gemini.js';
import { callClaude } from './providers/claude.js';
import { callYandexGpt } from './providers/yandexgpt.js';
import { synthesizeSpeech } from './providers/yandex-tts.js';
import { searchAndSummarize } from './providers/yandex-search.js';
import { classifyPassTypeByKeywords, classifyRequestKindByKeywords } from './prompt.js';

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
 *
 * 2026-09-06: для "разумных общих вопросов" не по теме ЖК (погода,
 * маршруты, факты) главная модель не пытается ответить сама — просит
 * поиск (type:"search") через yandex-search.js, и уже его результат
 * отдаётся приложению как обычный "info". Наружу тип "search" никогда
 * не уходит — Android-стороне про него знать не нужно.
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
    if (!knownFields.requestKind) {
        const guessedKind = classifyRequestKindByKeywords(transcript);
        if (guessedKind) knownFields.requestKind = guessedKind;
    }
    if (!knownFields.passType) {
        const guessed = classifyPassTypeByKeywords(transcript);
        if (guessed) knownFields.passType = guessed;
    }

    const providerName = String(process.env.LLM_PROVIDER || 'yandexgpt').toLowerCase();
    const call = PROVIDERS[providerName] || callYandexGpt;
    const env = process.env;

    try {
        const result = await call({ transcript, history, knownFields, env });

        // "search" — промежуточный шаг, наружу (в приложение) никогда не
        // уходит: модель только формулирует запрос, а реальный ответ
        // берём из отдельного поиска (см. yandex-search.js) и уже его
        // отдаём как обычный "info". Если поиск не удался — честно
        // говорим об этом, а не молчим и не читаем пустоту.
        if (result && result.type === 'search' && result.query) {
            try {
                const answer = await searchAndSummarize({ query: result.query, env });
                return res.json({
                    type: 'info',
                    question: null,
                    say: answer,
                    query: null,
                    action: null,
                    fields: result.fields || {},
                    message: answer,
                });
            } catch (searchErr) {
                console.error('search error:', searchErr);
                return res.json({
                    type: 'error',
                    question: null,
                    say: null,
                    query: null,
                    action: null,
                    fields: result.fields || {},
                    message: 'Не получилось найти ответ на этот вопрос. Могу помочь с пропуском или подсказать про заведения в комплексе.',
                });
            }
        }

        res.json(result);
    } catch (err) {
        // Полный текст ошибки (может содержать внутренние id облака/папки
        // и т.п.) — только в лог. Житель может услышать это в озвучке
        // ("message" из ответа читает вслух TTS) — сырую техническую
        // ошибку туда пускать нельзя, только дружелюбный текст.
        console.error('assist error:', err);
        res.status(502).json({
            type: 'error',
            message: 'Извините, сейчас не получается связаться с сервисом. Попробуйте, пожалуйста, ещё раз через минуту.',
        });
    }
});

async function handleTtsRequest(text, voice, res) {
    if (!text) {
        return res.status(400).json({ error: 'text is required' });
    }
    try {
        const audio = await synthesizeSpeech({ text, env: process.env, voice });
        res.set('content-type', 'audio/ogg');
        res.send(audio);
    } catch (err) {
        console.error('tts error:', err);
        res.status(502).json({ error: String((err && err.message) || err) });
    }
}

app.post('/tts', async (req, res) => {
    const text = String((req.body && req.body.text) || '').trim();
    // voice — необязательный параметр, только для ручного сравнения
    // голосов через curl (см. backend/README.md); Android-приложение его
    // не передаёт и всегда получает голос из YANDEX_TTS_VOICE на сервере.
    const voice = req.body && req.body.voice ? String(req.body.voice).trim() : undefined;
    await handleTtsRequest(text, voice, res);
});

// GET-вариант того же самого — только для ручного прослушивания через
// адресную строку браузера (PowerShell+curl на Windows слишком легко
// портит кириллицу в JSON-теле, см. историю проверки голоса). Android
// им не пользуется.
app.get('/tts', async (req, res) => {
    const text = String((req.query && req.query.text) || '').trim();
    const voice = req.query && req.query.voice ? String(req.query.voice).trim() : undefined;
    await handleTtsRequest(text, voice, res);
});

app.get('/health', (_req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT) || 3011;
app.listen(port, '127.0.0.1', () => {
    console.log(`d24-voice-assist listening on 127.0.0.1:${port}`);
});
