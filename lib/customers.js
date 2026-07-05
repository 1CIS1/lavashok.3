/* ============================================================
   Личные кабинеты клиентов (data/customers.json).
   Ключ — телефон (только цифры), значение — { passwordHash, createdAt }.
   Отдельно от бонусов (lib/loyalty.js): кабинет можно отключить/сбросить,
   не трогая баллы и историю заказов — они всё равно привязаны к телефону.
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DATA_DIR = require('./paths').DATA_DIR;
const FILE = path.join(DATA_DIR, 'customers.json');

function key(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, '{}', 'utf8');
}

function readAll() {
  ensure();
  try {
    const raw = fs.readFileSync(FILE, 'utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error('customers: не удалось прочитать customers.json —', e.message);
    return {};
  }
}

function writeAll(obj) {
  ensure();
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

/* Есть ли уже аккаунт (пароль) у этого телефона.
   Запись может существовать и без пароля (только prefs, заданные админом) —
   такая запись аккаунтом не считается. */
function exists(phone) {
  const k = key(phone);
  if (k.length < 5) return false;
  const rec = readAll()[k];
  return !!(rec && rec.passwordHash);
}

/* Создать аккаунт. Бросает исключение, если телефон некорректен или аккаунт уже есть.
   Существующие prefs (например, автопополнение, заданное админом) сохраняются. */
function create(phone, password) {
  const k = key(phone);
  if (k.length < 5) throw new Error('bad_phone');
  if (String(password || '').length < 4) throw new Error('bad_password');
  const all = readAll();
  if (all[k] && all[k].passwordHash) throw new Error('exists');
  all[k] = Object.assign({}, all[k], {
    passwordHash: bcrypt.hashSync(String(password), 10),
    createdAt: new Date().toISOString()
  });
  writeAll(all);
  return true;
}

/* Проверка пары телефон/пароль. */
function verify(phone, password) {
  const k = key(phone);
  const rec = readAll()[k];
  if (!rec || !rec.passwordHash) return false;
  return bcrypt.compareSync(String(password || ''), rec.passwordHash);
}

/* Установить/сбросить пароль (используется и клиентом при регистрации, и админом при сбросе). */
function setPassword(phone, password) {
  const k = key(phone);
  if (k.length < 5 || String(password || '').length < 4) return false;
  const all = readAll();
  all[k] = Object.assign({ createdAt: new Date().toISOString() }, all[k], {
    passwordHash: bcrypt.hashSync(String(password), 10)
  });
  writeAll(all);
  return true;
}

/* Настройки клиента (например, автопополнение карты) — хранятся в записи кабинета. */
function getPrefs(phone) {
  const rec = readAll()[key(phone)];
  return (rec && rec.prefs && typeof rec.prefs === 'object') ? rec.prefs : {};
}

/* Слить новые настройки с существующими. Если записи нет — создаёт её без пароля
   (админ настраивает карту клиенту, у которого ещё нет личного кабинета). */
function setPrefs(phone, prefs) {
  const k = key(phone);
  if (k.length < 5) return false;
  const all = readAll();
  if (!all[k]) all[k] = { createdAt: new Date().toISOString() };
  all[k].prefs = Object.assign({}, all[k].prefs, prefs);
  writeAll(all);
  return true;
}

module.exports = { exists, create, verify, setPassword, getPrefs, setPrefs };
