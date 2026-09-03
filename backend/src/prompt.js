/**
 * Системный промпт и схема ответа для голосового помощника киоска.
 * Общие для всех провайдеров (Gemini/Claude — на паузе из-за
 * региональной блокировки, см. backend/README.md), чтобы контракт
 * ответа не расходился между ними.
 *
 * Автозаполнение формы сейчас поддержано только для пропуска на машину
 * (order_car_pass) — это единственная форма, DOM которой у нас перед
 * глазами по реальным скриншотам lk.purehome.ru. Пешеходный пропуск
 * ("На вход") помощник умеет ВЕСТИ РАЗГОВОРОМ (спросить тип, ФИО,
 * апартамент) и озвучить итог, но не заполняет форму сам — экран
 * "На вход" мы пока не видели, чтобы писать по нему селекторы вслепую.
 *
 * В форме нет отдельных полей "апартамент"/"номер машиноместа" — по
 * словам заказчика (2026-09-04) это утекает в общее поле "Комментарий",
 * которое есть и в форме гостя, и в форме на машину.
 *
 * ВАЖНО про многошаговый диалог (2026-09-04): раньше модель на каждом
 * шаге получала всю историю и должна была САМА заново вспомнить/
 * восстановить уже названные ФИО и госномер — на практике это
 * приводило к тому, что она их подменяла (реальный кейс: госномер
 * А123ВС777 на втором шаге стал А123ХХ777). Для системы, которая
 * выдаёт пропуска на машины, это неприемлемо. Поэтому теперь клиент
 * присылает knownFields — то, что уже подтверждено на предыдущих
 * шагах, — и сервер (см. enforceKnownFields) ПРИНУДИТЕЛЬНО подставляет
 * эти значения в ответ, что бы модель ни написала в fields для тех же
 * ключей. Модели остаётся только извлекать НОВОЕ из текущей фразы —
 * она никогда не может ни подтвердить, ни изменить то, что уже
 * закреплено. То же самое для passType — по возможности определяется
 * простым разбором ключевых слов (classifyPassTypeByKeywords) ещё до
 * обращения к модели.
 */

export const FIELD_KEYS = [
    'passType', 'ownership', 'visitDate', 'plateNumber', 'plateType',
    'carLabel', 'guestName', 'parkingSpotNumber', 'destinationApartment',
];

/** Простая эвристика по ключевым словам — надёжнее, чем спрашивать LLM,
 *  когда сигнал явный; при неоднозначности возвращает null (тогда уже
 *  решает модель/уточняющий вопрос). */
export function classifyPassTypeByKeywords(text) {
    const t = String(text || '').toLowerCase();
    const looksLikeCar = /машин|авто|въезд|легков|паркинг|стоянк/.test(t);
    const looksLikeWalk = /пешех|пешком|без машины|не на машине|просто человек|на вход\b/.test(t);
    if (looksLikeCar && !looksLikeWalk) return 'car';
    if (looksLikeWalk && !looksLikeCar) return 'walkin';
    return null;
}

/** Сервер никогда не доверяет модели повторно "подтвердить" уже
 *  известные поля — просто принудительно подставляет сохранённые
 *  значения поверх того, что вернула модель. */
export function enforceKnownFields(result, knownFields) {
    if (!result || typeof result !== 'object') return result;
    const known = (knownFields && typeof knownFields === 'object') ? knownFields : {};
    if (!result.fields || typeof result.fields !== 'object') {
        result.fields = {};
    }
    for (const key of FIELD_KEYS) {
        if (known[key] !== undefined && known[key] !== null && known[key] !== '') {
            result.fields[key] = known[key];
        }
    }
    return result;
}

// "Strict" JSON-схема (как в OpenAI structured outputs) — YandexGPT
// (и, скорее всего, любой другой OpenAI-совместимый провайдер) требует,
// чтобы ВСЕ поля из properties были в required, без исключений; поля,
// которые по смыслу необязательны, вместо этого допускают null через
// type: [..., 'null']. Проверено на реальном ответе YandexGPT — без
// этого API отвечает 400 "all fields must be required".
//
// У Gemini свой диалект той же идеи: там вместо type: [..., 'null']
// используется отдельный флаг nullable: true, а required можно
// оставлять неполным — эту схему для него нужно будет адаптировать
// отдельно, один в один она не подойдёт.
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
                passType: { type: ['string', 'null'], enum: ['car', 'walkin', null] },
                ownership: { type: ['string', 'null'], enum: ['guest', 'own', null] },
                visitDate: { type: ['string', 'null'] },
                plateNumber: { type: ['string', 'null'] },
                plateType: { type: ['string', 'null'] },
                carLabel: { type: ['string', 'null'] },
                guestName: { type: ['string', 'null'] },
                parkingSpotNumber: { type: ['string', 'null'] },
                destinationApartment: { type: ['string', 'null'] },
            },
            required: [
                'passType', 'ownership', 'visitDate', 'plateNumber', 'plateType',
                'carLabel', 'guestName', 'parkingSpotNumber', 'destinationApartment',
            ],
            additionalProperties: false,
        },
        message: { type: ['string', 'null'] },
    },
    required: ['type', 'question', 'say', 'action', 'fields', 'message'],
    additionalProperties: false,
};

export function buildSystemPrompt(knownFields) {
    const today = new Date().toISOString().slice(0, 10);
    const known = (knownFields && typeof knownFields === 'object') ? knownFields : {};
    const knownEntries = FIELD_KEYS
        .filter((key) => known[key] !== undefined && known[key] !== null && known[key] !== '')
        .map((key) => `${key} = ${JSON.stringify(known[key])}`);
    const knownBlock = knownEntries.length
        ? `Уже ТОЧНО ПОДТВЕРЖДЕНО на предыдущих шагах этого разговора: ${knownEntries.join(', ')}. Эти значения заблокированы сервером — что бы ты про них ни написал в fields, сервер их всё равно перезапишет на уже подтверждённые. Поэтому НЕ пытайся их угадывать/восстанавливать заново и НЕ переспрашивай про них — считай их решённым делом и переходи к следующему недостающему полю по порядку ниже.`
        : 'Пока по этому разговору ничего не подтверждено.';

    return [
        'Ты — голосовой помощник на инфопанели жилого комплекса. Житель просит заказать пропуск.',
        `Сегодняшняя дата: ${today}.`,
        '',
        knownBlock,
        '',
        // Без этого блока и примеров ниже YandexGPT в проверке (2026-09-03)
        // стабильно ПРИДУМЫВАЛ госномер и имя гостя вместо того, чтобы
        // взять их из текста — даже при temperature=0. С примерами ниже
        // ошибка исчезла на новых, не встречавшихся в примерах именах и
        // номерах. Не убирать этот блок и не сокращать примеры.
        'КРИТИЧЕСКИ ВАЖНО: значения для guestName, plateNumber, parkingSpotNumber, destinationApartment переноси ТОЛЬКО дословно из ПОСЛЕДНЕЙ фразы жителя (transcript). Категорически запрещено придумывать, подставлять "типичное" имя/номер, или брать значения из этой инструкции/примеров ниже как будто это реальные данные. Если в последней фразе этого нет — значение null, а не выдумка.',
        '',
        'Разговор начинается с того, что ты (в приложении, не здесь) уже поздоровался и спросил, как к жителю обращаться — его первая реплика в истории обычно и есть ответ на это. Если удалось понять имя жителя — обращайся к нему по имени, тепло и по-соседски, в текстах question/say. Если имя не прозвучало — не используй обращение по имени и не переспрашивай его отдельно. Имя самого жителя и guestName (имя гостя в fields) — разные вещи, не путай их.',
        '',
        '=== Сценарий "пропуск на машину" (order_car_pass, автозаполнение формы работает) ===',
        'Если passType ещё не подтверждён (см. блок выше) и неясно из фразы — спроси: {"type":"ask","question":"Какой пропуск вам нужен — на машину или для человека без машины?"}.',
        'Дальше, СТРОГО по одному вопросу за раз, в этом порядке (пропускай то, что уже подтверждено):',
        '1. guestName (ФИО гостя) — обязательно.',
        '2. parkingSpotNumber (номер машиноместа) — спроси, но если житель прямо говорит, что не знает/не нужно — не настаивай, оставь null и иди дальше.',
        '3. plateNumber (госномер) — обязательно.',
        'Когда guestName и plateNumber подтверждены (parkingSpotNumber опционален) — верни {"type":"fill","action":"order_car_pass","fields":{...},"say":"..."}.',
        `Необязательные поля fields: visitDate (по умолчанию — сегодня, ${today}), carLabel, plateType (по умолчанию RUS).`,
        '',
        '=== Сценарий "пропуск для человека без машины" (пешеходный, "На вход") ===',
        'Автозаполнения формы для этого типа пока НЕТ — экран ещё не подключён. Веди диалог и собери данные по одному вопросу: сначала guestName, потом destinationApartment (в какой апартамент/к кому направляется). Когда оба подтверждены — верни {"type":"error","fields":{...},"message":"Пропуск для пешехода: <ФИО>, апартамент <N>. Автоматически оформить пока не могу — введите это, пожалуйста, вручную в разделе «На вход»."}. Даже это "error"-ответ ДОЛЖЕН содержать fields с собранными данными.',
        '',
        'Общие правила ответа — строго один JSON-объект по заданной схеме, без текста вне JSON:',
        '- Не хватает обязательного поля на текущем шаге — верни {"type":"ask","question":"<короткий вопрос по-русски, только один, по имени жителя если оно известно>"}.',
        '- Запрос вообще не про пропуск (заявка, показания счётчиков и т.п.) — верни {"type":"error","message":"Пока умею только помогать с пропусками. Остальное — через меню на экране."}.',
        '- Никогда не отправляй пропуск сам — только готовь данные для заполнения формы (order_car_pass), финальную кнопку «Заказать» всегда нажимает житель.',
        '',
        'Примеры (структура ответа такая же, как описано выше, здесь для краткости показаны только значимые поля; в примерах ниже считаем, что до этого ничего ещё не было подтверждено):',
        '- Вход: "закажите пропуск гостю Петру Сидорову на машине номер А123ВС777" → {"type":"ask","question":"Какой номер машиноместа?","fields":{"passType":"car","guestName":"Пётр Сидоров","plateNumber":"А123ВС777",...}}',
        '- Вход: "нужен пропуск на машину гостю" → {"type":"ask","question":"Как зовут гостя?","fields":{"passType":"car",...}}',
        '- Вход: "хочу заказать пропуск для человека, приедет Мария Иванова" → {"type":"ask","question":"В какой апартамент направляется Мария?","fields":{"passType":"walkin","guestName":"Мария Иванова",...}}',
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
