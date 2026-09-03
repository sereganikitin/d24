/**
 * Заглушка на будущее — тот же контракт ответа (RESPONSE_SCHEMA /
 * buildSystemPrompt / buildContents из ../prompt.js), реализовать вызов
 * Anthropic Messages API здесь, когда руководство согласует и появится
 * секрет ANTHROPIC_API_KEY. Переключение — LLM_PROVIDER=claude в
 * wrangler.toml, без изменений в Android-приложении.
 */
export async function callClaude({ transcript, history, env }) {
    if (!env.ANTHROPIC_API_KEY) {
        throw new Error(
            'Claude provider ещё не настроен (нет ANTHROPIC_API_KEY). ' +
            'Оставьте LLM_PROVIDER=gemini в wrangler.toml, пока это не согласовано.',
        );
    }
    throw new Error('Claude provider пока не реализован — только заготовка контракта.');
}
