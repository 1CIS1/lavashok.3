/* Сервис-воркер ЛавашОК — минимальный, для установки как приложение.
   Кэширование не используем (данные всегда свежие), запросы идут в сеть. */
'use strict';

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

/* Passthrough: ничего не перехватываем, всё уходит в сеть как обычно.
   Наличие обработчика fetch требуется для установки приложения в части браузеров. */
self.addEventListener('fetch', function () {
  /* no-op — браузер выполнит запрос сам */
});
