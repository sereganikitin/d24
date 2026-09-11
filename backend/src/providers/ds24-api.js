const DEFAULT_BASE = 'https://ds24.ru/piedpiper/v2';

/**
 * Реальный список помещений ЖК Зорге 9 из Dispatcher24 (API УК, доступ
 * согласован письмом от ds24.ru 2026-09-10/11, интеграционный токен —
 * только чтение, писать в систему нельзя и не пытаемся).
 *
 * ВАЖНО: продакшен — https://ds24.ru/piedpiper/v2, а НЕ s0.ds24.ru
 * (последний, судя по их же публичной OpenAPI-документации, "Test env",
 * с интеграционным токеном отвечает 401) — проверено вживую 2026-09-11.
 *
 * Список домов (GET /v2/ref/address_list) — стабильный справочник,
 * поэтому захардкожен, как VENUE_DIRECTORY, а не запрашивается заново
 * каждый раз. Если УК добавит/переименует корпус — поправить здесь.
 */
const HOUSES = [
    { house_id: 248155, label: '9А К1' },
    { house_id: 248156, label: '9А К6' },
    { house_id: 248157, label: '9А К7' },
    { house_id: 248158, label: '9А С4' },
    { house_id: 248159, label: '9А С5' },
    { house_id: 248160, label: '9А С8' },
    { house_id: 249778, label: '9А К6 паркинг' },
];

// FlatTypeEnum из спецификации Dispatcher24 — этот комплекс апарт-формата
// (address_list: is_apart="Д"), поэтому жилые юниты идут под кодом 7
// "Апартаменты", а не 1 "Квартира".
const FLAT_TYPE_APARTMENT = 7;
const FLAT_TYPE_PARKING = 3;

// Реальные номера — не всегда чистые числа: встречаются разделённые
// апартаменты ("17/1", "17/2" — объединённые/поделённые лоты) и
// машиноместа с суффиксом секции ("16/А", "115/м"). Житель по голосу
// скорее всего назовёт только базовый номер без дроби — поэтому кроме
// точного совпадения проверяем совпадение по части до "/".
function baseNumber(flatNum) {
    const idx = String(flatNum).indexOf('/');
    return idx === -1 ? String(flatNum) : String(flatNum).slice(0, idx);
}

let cache = null; // { apartments: Set<string>, apartmentBases: Set<string>, parkingSpots: Set<string>, parkingBases: Set<string>, fetchedAt: number }
const CACHE_TTL_MS = 60 * 60 * 1000; // час — справочник помещений почти не меняется, не дёргаем API на каждый чих

async function fetchFlatList(houseId, env) {
    const token = env.DS24_API_TOKEN;
    const base = env.DS24_API_BASE || DEFAULT_BASE;
    const res = await fetch(`${base}/ref/flat_list?house_id=${houseId}`, {
        headers: { authorization: token },
    });
    if (!res.ok) {
        throw new Error(`Dispatcher24 flat_list error ${res.status} (house_id=${houseId})`);
    }
    const data = await res.json();
    return Array.isArray(data) ? data : (data.data || data.items || []);
}

async function rebuildCache(env) {
    const apartments = new Set();
    const apartmentBases = new Set();
    const parkingSpots = new Set();
    const parkingBases = new Set();

    for (const house of HOUSES) {
        const flats = await fetchFlatList(house.house_id, env);
        for (const f of flats) {
            if (!f.flat_num) continue;
            const num = String(f.flat_num).trim();
            if (f.flat_type === FLAT_TYPE_APARTMENT) {
                apartments.add(num);
                apartmentBases.add(baseNumber(num));
            } else if (f.flat_type === FLAT_TYPE_PARKING) {
                parkingSpots.add(num);
                parkingBases.add(baseNumber(num));
            }
        }
    }

    cache = { apartments, apartmentBases, parkingSpots, parkingBases, fetchedAt: Date.now() };
    console.log(`Dispatcher24: справочник помещений обновлён — ${apartments.size} апартаментов, ${parkingSpots.size} машиномест.`);
}

async function ensureCache(env) {
    if (!env.DS24_API_TOKEN) return null; // интеграция не настроена — валидацию просто пропускаем
    if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache;
    try {
        await rebuildCache(env);
        return cache;
    } catch (err) {
        console.error('Dispatcher24: не удалось обновить справочник помещений:', err);
        return cache; // устаревший кэш лучше, чем никакого; если кэша ещё не было — вернётся null
    }
}

/** true/false — есть такой номер или нет; null — не смогли проверить
 *  (интеграция не настроена или Dispatcher24 недоступен), в этом случае
 *  вызывающий код должен просто пропустить проверку, а не считать отказом. */
export async function isKnownApartment(num, env) {
    const c = await ensureCache(env);
    if (!c) return null;
    const n = String(num).trim();
    return c.apartments.has(n) || c.apartmentBases.has(n);
}

export async function isKnownParkingSpot(num, env) {
    const c = await ensureCache(env);
    if (!c) return null;
    const n = String(num).trim();
    return c.parkingSpots.has(n) || c.parkingBases.has(n);
}

/** Прогрев кэша при старте сервера, чтобы первый реальный запрос
 *  жителя не ждал 7 последовательных вызовов Dispatcher24. */
export function warmDs24Cache(env) {
    ensureCache(env).catch(() => {}); // ошибки уже залогированы внутри ensureCache
}
