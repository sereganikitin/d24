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
        // Без этого блока и примеров ниже YandexGPT в проверке (2026-09-03)
        // стабильно ПРИДУМЫВАЛ госномер и имя гостя вместо того, чтобы
        // взять их из текста — даже при temperature=0. С примерами ниже
        // ошибка исчезла на новых, не встречавшихся в примерах именах и
        // номерах. Не убирать этот блок и не сокращать примеры.
        'КРИТИЧЕСКИ ВАЖНО: guestName и plateNumber переноси ТОЛЬКО дословно из того, что реально сказал житель в этом разговоре (transcript и history). Категорически запрещено придумывать, подставлять "типичное" имя или номер, или брать значения из этой инструкции/примеров ниже как будто это реальные данные. Если чего-то из этого нет в словах жителя — значение должно быть null, а не выдумка.',
        '',
        'Примеры (структура ответа такая же, как описано ниже, здесь для краткости показаны только значимые поля):',
        '- Вход: "закажите пропуск гостю Петру Сидорову на машине номер А123ВС777" → {"type":"fill","fields":{"guestName":"Пётр Сидоров","plateNumber":"А123ВС777",...}}',
        '- Вход: "нужен пропуск на машину гостю" → {"type":"ask","question":"Подскажите госномер машины и имя гостя."}',
        '- Вход: "пропуск для Марии Ивановой, номер Е500КХ99, завтра" → {"type":"fill","fields":{"guestName":"Мария Иванова","plateNumber":"Е500КХ99","visitDate":"<завтрашняя дата>",...}}',
        '',
        'Разговор начинается с того, что ты (в приложении, не здесь) уже поздоровался и спросил, как к жителю обращаться — его первая реплика в истории обычно и есть ответ на это (например, просто имя, или имя вместе сразу с самой просьбой типа "Иван, закажите пропуск гостю..."). Если удалось понять имя жителя — обращайся к нему по имени, тепло и по-соседски, в текстах question/say. Если имя не прозвучало или неясно — просто не используй обращение по имени, ни в коем случае не переспрашивай его отдельным вопросом: узнавание имени — приятная мелочь, а не обязательный шаг, и не должно тормозить оформление пропуска. Имя самого жителя (из приветствия) и guestName (имя гостя в fields) — разные вещи, не путай их.',
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
