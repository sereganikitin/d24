const MCP_ENDPOINT = 'https://mcp.vkusvill.ru/mcp';

/**
 * Официальный MCP-сервер ВкусВилла (mcp.vkusvill.ru) — публичный, без
 * авторизации, проверено вживую 2026-09-10 (initialize/tools list/tools
 * call все отвечают без какого-либо ключа или Mcp-Session-Id). В доме
 * есть настоящий ВкусВилл (см. VENUE_DIRECTORY в prompt.js), поэтому
 * жители могут спрашивать про конкретные товары/цены/акции, а не только
 * "в каком корпусе магазин".
 *
 * Важно: vkusvill_products_search/vkusvill_products_discount — это
 * общий каталог ВкусВилла (не привязан к конкретному магазину), цены
 * могут отличаться от цен в конкретном магазине дома — это честно
 * добавляется в текст ответа, а не выдаётся как гарантированная цена.
 *
 * Протокол — обычный MCP (JSON-RPC 2.0) поверх HTTP, без стриминга —
 * сервер отвечает одним JSON-объектом на POST, сессии не требуются
 * (стейтлес), поэтому отдельный MCP SDK не подключаем, хватает fetch.
 */
let requestId = 0;

async function callTool(name, args) {
    const res = await fetch(MCP_ENDPOINT, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: ++requestId,
            method: 'tools/call',
            params: { name, arguments: args },
        }),
    });

    if (!res.ok) {
        throw new Error(`VkusVill MCP HTTP error ${res.status}`);
    }

    const outer = await res.json();
    if (outer.error) {
        throw new Error(`VkusVill MCP error: ${outer.error.message || JSON.stringify(outer.error)}`);
    }
    const text = outer.result && outer.result.content && outer.result.content[0] && outer.result.content[0].text;
    if (!text) throw new Error('VkusVill MCP returned no content');

    const inner = JSON.parse(text);
    if (!inner.ok) throw new Error('VkusVill MCP tool reported ok:false');
    return inner.data;
}

// Названия товаров приходят с HTML-сущностями (например "1&nbsp;л") —
// не годится для озвучки как есть, чистим так же, как markdown в
// yandex-search.js.
function cleanProductName(name) {
    return String(name || '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
}

function formatItems(items) {
    return items.map((item) => {
        const name = cleanProductName(item.name);
        const price = item.price && typeof item.price.current === 'number' ? `${item.price.current} ₽` : null;
        return price ? `«${name}» — ${price}` : `«${name}»`;
    });
}

const CATALOG_CAVEAT = 'Это данные из общего каталога ВкусВилл — в конкретном магазине дома цена или наличие могут немного отличаться.';

/** Возвращает готовую фразу для say/message — либо список найденных
 *  товаров, либо честное "ничего не нашлось". */
export async function searchVkusVillProducts(query) {
    const data = await callTool('vkusvill_products_search', { q: query, mode: 'short', sort: 'popularity' });
    const items = (data && data.items) || [];
    if (!items.length) {
        return `В каталоге ВкусВилл по запросу «${query}» ничего не нашлось.`;
    }
    const top = formatItems(items.slice(0, 5));
    return `В каталоге ВкусВилл нашлось: ${top.join(', ')}. ${CATALOG_CAVEAT}`;
}

export async function getVkusVillDiscounts() {
    const data = await callTool('vkusvill_products_discount', { type: 'card', sort: 'popularity' });
    const items = (data && data.items) || [];
    if (!items.length) {
        return 'Сейчас в каталоге ВкусВилл не нашлось акционных товаров.';
    }
    const top = formatItems(items.slice(0, 5));
    return `Сейчас в ВкусВилл по акции: ${top.join(', ')}. ${CATALOG_CAVEAT}`;
}
