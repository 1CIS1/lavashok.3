/* ============================================================
   Генератор bcrypt-хеша пароля для админки.
   Использование:
     node scripts/hash-password.js "мой-пароль"
   Полученную строку положите в переменную окружения ADMIN_PASS_HASH
   (тогда пароль в открытом виде нигде не хранится).
   ============================================================ */
'use strict';

const bcrypt = require('bcryptjs');

const pw = process.argv[2];
if (!pw) {
  console.error('Укажите пароль: node scripts/hash-password.js "ваш-пароль"');
  process.exit(1);
}

const hash = bcrypt.hashSync(pw, 10);
console.log('');
console.log('ADMIN_PASS_HASH=' + hash);
console.log('');
console.log('Добавьте эту строку в .env или задайте как переменную окружения.');
