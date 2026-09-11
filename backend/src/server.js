import express from 'express';
import { callGemini } from './providers/gemini.js';
import { callClaude } from './providers/claude.js';
import { callYandexGpt } from './providers/yandexgpt.js';
import { synthesizeSpeech } from './providers/yandex-tts.js';
import { searchAndSummarize } from './providers/yandex-search.js';
import { searchVkusVillProducts, getVkusVillDiscounts } from './providers/vkusvill-mcp.js';
import { isKnownApartment, isKnownParkingSpot, warmDs24Cache } from './providers/ds24-api.js';
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
 *
 * 2026-09-10: тот же приём для vv_search/vv_discounts — вопросы про
 * конкретные товары/акции настоящего ВкусВилла в доме, через его
 * публичный MCP-сервер (vkusvill-mcp.js). Только чтение каталога, без
 * реальных заказов — финальную корзину/покупку житель всё равно делает
 * сам через сайт/приложение ВкусВилла.
 *
 * 2026-09-11: apartment/parkingSpotNumber, которые называет житель,
 * сверяются с реальным справочником помещений Dispatcher24 (ds24-api.js,
 * тоже только чтение) — если такого номера нет ни в одном доме
 * комплекса, ассистент переспрашивает вместо того, чтобы молча принять
 * произвольное число. Если интеграция не настроена или Dispatcher24
 * недоступен — проверка тихо пропускается, это не блокирует пропуск.
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

    // Общий шаблон для "промежуточных" типов (search/vv_search/vv_discounts):
    // модель только просит что-то найти, наружу в приложение эти типы
    // никогда не уходят — реальный ответ берётся отдельным вызовом и
    // отдаётся как обычный "info"/"error". См. подробное объяснение
    // бага 2026-09-06 в git-истории: раньше пустой query в type:"search"
    // приводил к тому, что сырой объект улетал клиенту как есть, а
    // Android не знал такого типа и молчал после "Что-то пошло не так".
    async function respondFromLookup(lookup, fields, failureMessage) {
        try {
            const answer = await lookup();
            return res.json({
                type: 'info', question: null, say: answer, query: null,
                action: null, fields: fields || {}, message: answer, options: null,
            });
        } catch (lookupErr) {
            console.error('lookup error:', lookupErr);
            return res.json({
                type: 'error', question: null, say: null, query: null,
                action: null, fields: fields || {}, message: failureMessage, options: null,
            });
        }
    }

    // Сверяет apartment/parkingSpotNumber, если модель их только что
    // извлекла из фразы, с реальным справочником помещений Dispatcher24.
    // Работает только для ask/fill — это единственные типы, где вообще
    // бывают такие поля; isKnownX возвращает null, если проверить не
    // удалось (интеграция не настроена/Dispatcher24 недоступен) — в этом
    // случае ничего не меняем, а не блокируем житителя из-за нашей же
    // технической проблемы.
    async function validateAgainstDs24(result) {
        if (!result || !result.fields) return result;
        if (result.type !== 'ask' && result.type !== 'fill') return result;

        const apt = result.fields.destinationApartment;
        if (apt) {
            const known = await isKnownApartment(apt, env);
            if (known === false) {
                return {
                    type: 'ask',
                    question: `Не нашёл апартамент номер ${apt} в этом доме. Повторите, пожалуйста, номер ещё раз.`,
                    say: null, query: null, action: null,
                    fields: { ...result.fields, destinationApartment: null },
                    message: null, options: null,
                };
            }
        }

        const spot = result.fields.parkingSpotNumber;
        if (spot) {
            const known = await isKnownParkingSpot(spot, env);
            if (known === false) {
                return {
                    type: 'ask',
                    question: `Не нашёл машиноместо номер ${spot} в этом доме. Повторите, пожалуйста, номер ещё раз.`,
                    say: null, query: null, action: null,
                    fields: { ...result.fields, parkingSpotNumber: null },
                    message: null, options: null,
                };
            }
        }

        return result;
    }

    try {
        let result = await call({ transcript, history, knownFields, env });
        result = await validateAgainstDs24(result);

        if (result && result.type === 'search') {
            return await respondFromLookup(
                () => {
                    if (!result.query) throw new Error('model returned type:"search" without a query');
                    return searchAndSummarize({ query: result.query, env });
                },
                result.fields,
                'Не получилось найти ответ на этот вопрос. Могу помочь с пропуском или подсказать про заведения в комплексе.',
            );
        }

        if (result && result.type === 'vv_search') {
            return await respondFromLookup(
                () => {
                    if (!result.query) throw new Error('model returned type:"vv_search" without a query');
                    return searchVkusVillProducts(result.query);
                },
                result.fields,
                'Не получилось проверить каталог ВкусВилл. Попробуйте, пожалуйста, ещё раз.',
            );
        }

        if (result && result.type === 'vv_discounts') {
            return await respondFromLookup(
                () => getVkusVillDiscounts(),
                result.fields,
                'Не получилось проверить акции ВкусВилл. Попробуйте, пожалуйста, ещё раз.',
            );
        }

        // Последний рубеж: что бы ни случилось выше по цепочке, наружу
        // должен уйти только один из типов, которые реально понимает
        // Android-клиент. Если модель (несмотря на строгую json-схему)
        // всё же вернула что-то другое — не отдаём это клиенту как есть,
        // а превращаем в обычную дружелюбную ошибку.
        const KNOWN_CLIENT_TYPES = ['ask', 'fill', 'error', 'info'];
        if (!result || !KNOWN_CLIENT_TYPES.includes(result.type)) {
            console.error('assist: unexpected response shape from model:', JSON.stringify(result));
            return res.json({
                type: 'error',
                question: null,
                say: null,
                query: null,
                action: null,
                fields: (result && result.fields) || {},
                message: 'Не получилось разобрать запрос. Попробуйте, пожалуйста, ещё раз.',
                options: null,
            });
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
            options: null,
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

// Прогреваем справочник помещений Dispatcher24 сразу при старте, чтобы
// первый реальный запрос жителя не ждал 7 последовательных вызовов API.
warmDs24Cache(process.env);
