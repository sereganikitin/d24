# d24-voice-assist — backend-прокси для голосового помощника

Маленький сервер между киоском и LLM. Держит API-ключ на своей стороне
(в Android-приложении его светить нельзя), принимает распознанный
голосом текст, возвращает либо уточняющий вопрос, либо данные для
заполнения формы пропуска.

Изначально задумывался как Cloudflare Worker, но у Cloudflare бывают
перебои с доступностью в России без VPN — деплоится на свой сервер
(72.56.12.105, тот же, что и остальные проекты на infoseledka.ru).
`src/prompt.js` и `src/providers/*.js` от хостинга не зависят, так что
при желании то же самое можно снова завернуть в Worker.

## Деплой (на сервере 72.56.12.105)

Домен: **d24-voice.infoseledka.ru** — DNS управляется через Timeweb, A-запись
`d24-voice → 72.56.12.105` добавляется в панели Timeweb (у сервера нет к ней
доступа, это делается отдельно, один раз).

```bash
# на сервере, от root
cd /var/www
git clone https://github.com/sereganikitin/d24.git d24-voice-assist
cd d24-voice-assist/backend
npm install --omit=dev

cp .env.example .env
nano .env                 # вписать реальный GEMINI_API_KEY

pm2 start ecosystem.config.cjs
pm2 save                  # чтобы пережило перезагрузку (pm2-root.service уже настроен)
```

Ключ Gemini — в [Google AI Studio](https://aistudio.google.com/apikey),
бесплатно в рамках free tier.

nginx-конфиг (`/etc/nginx/sites-available/d24-voice.infoseledka.ru`,
по образцу соседних сайтов на этом сервере — сначала plain HTTP, затем
`certbot --nginx -d d24-voice.infoseledka.ru` сам допишет SSL-блок и
редирект, как у `parking.infoseledka.ru`):

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name d24-voice.infoseledka.ru;

    location / {
        proxy_pass http://127.0.0.1:3011;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/d24-voice.infoseledka.ru /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d d24-voice.infoseledka.ru
```

## Обновление после правок в репозитории

```bash
cd /var/www/d24-voice-assist
git pull
cd backend && npm install --omit=dev
pm2 restart d24-voice-assist
```

## Контракт API

`POST /assist`, тело:
```json
{
  "transcript": "закажи гостю пропуск на машину номер А123ВС777 иван петров сегодня",
  "history": [
    { "role": "user", "text": "..." },
    { "role": "assistant", "text": "..." }
  ]
}
```
`history` — необязательно, нужно только для многошагового диалога
(когда помощник до этого что-то уточнял).

Ответ — один из трёх вариантов:
```json
{ "type": "ask", "question": "Уточните госномер машины" }
```
```json
{
  "type": "fill",
  "action": "order_car_pass",
  "fields": {
    "ownership": "guest",
    "visitDate": "2026-09-03",
    "plateNumber": "А123ВС777",
    "plateType": "RUS",
    "carLabel": "",
    "guestName": "Иван Петров"
  },
  "say": "Готовлю разовый гостевой пропуск на въезд для машины А123ВС777, гость Иван Петров, дата — сегодня."
}
```
```json
{ "type": "error", "message": "..." }
```

Пропуск сам не отправляется — `fields`/`say` только для заполнения
формы, финальное «Заказать» нажимает житель.

`GET /health` — простой healthcheck (`{"ok":true}`), без вызова LLM.

## Смена провайдера на Claude (когда согласует руководство)

1. В `.env` на сервере добавить `ANTHROPIC_API_KEY=...`.
2. Реализовать сам вызов Anthropic Messages API в
   `src/providers/claude.js` (контракт ответа уже описан в
   `src/prompt.js`, переиспользуется без изменений).
3. В `.env` поменять `LLM_PROVIDER=gemini` на `LLM_PROVIDER=claude`,
   `pm2 restart d24-voice-assist`.

Android-приложение и `kiosk-inject.js` не меняются вообще — они знают
только про `POST /assist` и формат ответа.

## Локальная проверка

```bash
cd backend
npm install
cp .env.example .env   # и вписать GEMINI_API_KEY
node --env-file=.env src/server.js
curl -X POST http://localhost:3011/assist \
  -H "content-type: application/json" \
  -d '{"transcript":"закажи гостю пропуск на машину номер А123ВС777 иван петров сегодня"}'
```
