/* ============================================================
   Фасад хранилища: выбирает драйвер.
   • по умолчанию пытается SQLite (data/orders.db);
   • если better-sqlite3 не установлен/не собрался — JSON-файл;
   • STORE_DRIVER=json принудительно включает JSON-режим.
   server.js работает с этим модулем и не знает, какой драйвер внутри.
   ============================================================ */
'use strict';

let impl = null;
const forced = (process.env.STORE_DRIVER || '').toLowerCase();

if (forced !== 'json') {
  try {
    impl = require('./store-sqlite');
    console.log('store: SQLite (data/orders.db)');
  } catch (e) {
    console.warn('store: SQLite недоступен (' + e.message + '). Переключаюсь на JSON-файл.');
  }
}

if (!impl) {
  impl = require('./store-json');
  console.log('store: JSON-файл (data/orders.json)');
}

module.exports = impl;
