# 🚀 Деплой ЛавашОК

Три способа — от простого к продвинутому. Для всех нужен сервер (VPS) с Docker
или Node.js и доменом, направленным на его IP.

---

## Вариант 1. Локально / тест (без Docker)

```bash
npm install
npm start
```
Сайт на `http://localhost:3000`. Подходит для разработки и демонстрации.

---

## Вариант 2. Docker (один контейнер)

Самый простой «боевой» запуск. На сервере с установленным Docker:

```bash
# 1) задайте секреты (один раз)
cp .env.example .env
nano .env            # пропишите ADMIN_PASS, SESSION_SECRET, при желании ключи ЮKassa

# 2) соберите и запустите
docker compose up -d --build
```

Приложение поднимется на порту `3000`, заказы будут сохраняться в папке `./data`
на сервере (том примонтирован). Обновление после изменений: `docker compose up -d --build`.

> `SESSION_SECRET` задайте обязательно (любая длинная случайная строка) — иначе при
> перезапуске контейнера администратора будет «разлогинивать».

---

## Вариант 3. Docker + HTTPS (nginx + Let's Encrypt)

Полноценный продакшен с шифрованием. Нужен домен, указывающий на сервер.

1. Впишите домен в `nginx/lavashok.conf` (три места `ВАШ-ДОМЕН`).
2. В `.env` задайте `PUBLIC_URL=https://ваш-домен` — тогда cookie станут `secure`,
   а ссылки возврата после оплаты будут корректными.
3. Получите сертификат Let's Encrypt (один раз):

   ```bash
   # поднимаем только nginx для прохождения проверки домена
   docker compose -f docker-compose.yml -f docker-compose.https.yml up -d nginx

   docker run --rm \
     -v "$PWD/nginx/certbot/conf:/etc/letsencrypt" \
     -v "$PWD/nginx/certbot/www:/var/www/certbot" \
     certbot/certbot certonly --webroot -w /var/www/certbot \
     -d ваш-домен --email you@example.com --agree-tos --no-eff-email
   ```

4. Запустите всё вместе:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.https.yml up -d --build
   ```

Сайт откроется по `https://ваш-домен`, http будет редиректить на https.
Продление сертификата: `certbot renew` (можно по крону) + `docker compose ... restart nginx`.

---

## Хостинги «из коробки» (без своего сервера)

Проект — обычное Node-приложение, поэтому легко разворачивается на платформах,
которые сами дают HTTPS и домен (Render, Railway, Timeweb Cloud Apps и т.п.):

- команда старта: `npm start`;
- переменные окружения из `.env.example` пропишите в настройках проекта;
- для постоянного хранения заказов подключите диск/том на путь `./data`
  (или переключитесь на внешнюю БД, переписав `lib/store.js`).

---

## Чек-лист безопасности перед публикацией

- [ ] Сменить пароль админки: `npm run hash "новый-пароль"` → положить вывод в `ADMIN_PASS_HASH`.
- [ ] Задать длинный `SESSION_SECRET`.
- [ ] Включить HTTPS (вариант 3 или хостинг с TLS).
- [ ] Прописать боевые ключи ЮKassa и `PUBLIC_URL`.
- [ ] В личном кабинете ЮKassa указать вебхук: `https://ваш-домен/api/yookassa-webhook`.
- [ ] Заменить `https://ВАШ-ДОМЕН` в Open Graph-тегах `index.html` на реальный домен.
