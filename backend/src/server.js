import express from 'express';
import { callGemini } from './providers/gemini.js';
import { callClaude } from './providers/claude.js';

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
 */
const app = express();
app.use(express.json());

app.post('/assist', async (req, res) => {
    const transcript = String((req.body && req.body.transcript) || '').trim();
    if (!transcript) {
        return res.status(400).json({ type: 'error', message: 'transcript is required' });
    }
    const history = Array.isArray(req.body && req.body.history) ? req.body.history : [];

    const provider = String(process.env.LLM_PROVIDER || 'gemini').toLowerCase();
    const env = process.env;

    try {
        const result = provider === 'claude'
            ? await callClaude({ transcript, history, env })
            : await callGemini({ transcript, history, env });
        res.json(result);
    } catch (err) {
        console.error('assist error:', err);
        res.status(502).json({ type: 'error', message: String((err && err.message) || err) });
    }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT) || 3011;
app.listen(port, '127.0.0.1', () => {
    console.log(`d24-voice-assist listening on 127.0.0.1:${port}`);
});
