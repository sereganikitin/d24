/**
 * Системный промпт и схема ответа для голосового помощника киоска.
 * Общие для всех провайдеров (Gemini сейчас, Claude — когда согласует
 * руководство), чтобы контракт ответа не расходился между ними.
 *
 * Сейчас поддержано только одно действие — order_car_pass (гостевой
 * пропуск на въезд для машины гостя), т.к. только эта форма у нас перед
 * глазами по реальным скриншотам lk.purehome.ru. Пешеходный пропуск
 * ("На вход") и остальные разделы (заявки, показания) — следующие шаги,
 * когда увидим соответствующие экраны.
 */

export const RESPONSE_SCHEMA = {
    type: 'object',
    properties: {
        type: { type: 'string', enum: ['ask', 'fill', 'error'] },
        question: { type: 'string' },
        say: { type: 'string' },
        action: { type: 'string', enum: ['order_car_pass'] },
        fields: {
            type: 'object',
            properties: {
                ownership: { type: 'string', enum: ['guest', 'own'] },
                visitDate: { type: 'string' },
                plateNumber: { type: 'string' },
                plateType: { type: 'string' },
                carLabel: { type: 'string' },
                guestName: { type: 'string' },
            },
        },
        message: { type: 'string' },
    },
    required: ['type'],
};

export function buildSystemPrompt() {
    const today = new Date().toISOString().slice(0, 10);
    return [
        'Ты — голосовой помощник на инфопанели жилого комплекса. Житель просит заказать пропуск.',
        `Сегодняшняя дата: ${today}.`,
        '',
        'Сейчас поддержано только одно действие — order_car_pass (гостевой пропуск на въезд для гостя на машине).',
        'Обязательные поля: plateNumber (госномер), guestName (имя и фамилия гостя).',
        `Необязательные: visitDate (по умолчанию — сегодня, ${today}), carLabel, plateType (по умолчанию RUS).`,
        '',
        'Правила ответа — строго один JSON-объект по заданной схеме, без текста вне JSON:',
        '- Не хватает обязательных полей (plateNumber или guestName) — верни {"type":"ask","question":"<короткий уточняющий вопрос по-русски, только один за раз>"}.',
        '- Данных достаточно — верни {"type":"fill","action":"order_car_pass","fields":{...},"say":"<короткая фраза по-русски для голосового подтверждения того, что подготовлено>"}.',
        '- Запрос не про гостевой пропуск на машину (например, пешеходный пропуск, заявка, показания счётчиков) — верни {"type":"error","message":"Пока умею только оформлять гостевой пропуск на машину. Остальное — через меню на экране."}.',
        '- Никогда не отправляй пропуск сам — только готовь данные для заполнения формы, финальную кнопку «Заказать» нажимает житель.',
    ].join('\n');
}

// Формат Gemini (contents[].parts[].text, role model|user).
export function buildContents(transcript, history) {
    const contents = [];
    for (const turn of history || []) {
        if (!turn || !turn.text) continue;
        contents.push({
            role: turn.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: String(turn.text) }],
        });
    }
    contents.push({ role: 'user', parts: [{ text: transcript }] });
    return contents;
}

// Формат OpenAI-совместимых API (YandexGPT, и Claude тоже может через
// свой Messages API переиспользовать эту же форму role/content).
export function buildOpenAiMessages(transcript, history) {
    const messages = [];
    for (const turn of history || []) {
        if (!turn || !turn.text) continue;
        messages.push({
            role: turn.role === 'assistant' ? 'assistant' : 'user',
            content: String(turn.text),
        });
    }
    messages.push({ role: 'user', content: transcript });
    return messages;
}
