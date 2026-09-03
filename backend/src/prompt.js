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

// "Strict" JSON-схема (как в OpenAI structured outputs) — YandexGPT
// (и, скорее всего, любой другой OpenAI-совместимый провайдер) требует,
// чтобы ВСЕ поля из properties были в required, без исключений; поля,
// которые по смыслу необязательны, вместо этого допускают null через
// type: [..., 'null']. Проверено на реальном ответе YandexGPT — без
// этого API отвечает 400 "all fields must be required".
//
// У Gemini (сейчас не используется — блокирует Россию, см.
// backend/README.md) свой диалект той же идеи: там вместо type: [...,
// 'null'] используется отдельный флаг nullable: true, а required можно
// оставлять неполным. Если Gemini вернётся в строй через релей — эту
// схему для него нужно будет адаптировать отдельно, один в один она не
// подойдёт.
export const RESPONSE_SCHEMA = {
    type: 'object',
    properties: {
        type: { type: 'string', enum: ['ask', 'fill', 'error'] },
        question: { type: ['string', 'null'] },
        say: { type: ['string', 'null'] },
        action: { type: ['string', 'null'], enum: ['order_car_pass', null] },
        fields: {
            type: ['object', 'null'],
            properties: {
                ownership: { type: ['string', 'null'], enum: ['guest', 'own', null] },
                visitDate: { type: ['string', 'null'] },
                plateNumber: { type: ['string', 'null'] },
                plateType: { type: ['string', 'null'] },
                carLabel: { type: ['string', 'null'] },
                guestName: { type: ['string', 'null'] },
            },
            required: ['ownership', 'visitDate', 'plateNumber', 'plateType', 'carLabel', 'guestName'],
            additionalProperties: false,
        },
        message: { type: ['string', 'null'] },
    },
    required: ['type', 'question', 'say', 'action', 'fields', 'message'],
    additionalProperties: false,
};

export function buildSystemPrompt() {
    const today = new Date().toISOString().slice(0, 10);
    return [
        'Ты — голосовой помощник на инфопанели жилого комплекса. Житель просит заказать пропуск.',
        `Сегодняшняя дата: ${today}.`,
        '',
        'Разговор начинается с того, что ты (в приложении, не здесь) уже поздоровался и спросил, как к жителю обращаться — его первая реплика в истории обычно и есть ответ на это (например, просто имя, или имя вместе сразу с самой просьбой типа "Иван, закажите пропуск гостю..."). Если удалось понять имя жителя — обращайся к нему по имени, тепло и по-соседски, в текстах question/say. Если имя не прозвучало или неясно — просто не используй обращение по имени, ни в коем случае не переспрашивай его отдельным вопросом: узнавание имени — приятная мелочь, а не обязательный шаг, и не должно тормозить оформление пропуска.',
        '',
        'Сейчас поддержано только одно действие — order_car_pass (гостевой пропуск на въезд для гостя на машине).',
        'Обязательные поля: plateNumber (госномер), guestName (имя и фамилия гостя).',
        `Необязательные: visitDate (по умолчанию — сегодня, ${today}), carLabel, plateType (по умолчанию RUS).`,
        '',
        'Правила ответа — строго один JSON-объект по заданной схеме, без текста вне JSON:',
        '- Не хватает обязательных полей (plateNumber или guestName) — верни {"type":"ask","question":"<короткий уточняющий вопрос по-русски, только один за раз, по имени если оно известно>"}.',
        '- Данных достаточно — верни {"type":"fill","action":"order_car_pass","fields":{...},"say":"<короткая фраза по-русски для голосового подтверждения того, что подготовлено, по имени если оно известно>"}.',
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
