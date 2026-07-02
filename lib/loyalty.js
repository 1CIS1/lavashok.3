/* ============================================================
   Бонусные баллы клиентов (data/loyalty.json).
   Ключ — телефон (только цифры), значение — { balance, lifetimeSpend }.
     • balance       — сколько баллов сейчас можно потратить (1 балл = 1 ₽).
     • lifetimeSpend — сумма всех заказов клиента за всё время (₽, без учёта
                        скидок/баллов) — по ней определяется уровень (тир).
   Формат совместим со старым: если в файле встретится просто число
   (старый формат «phone: баланс»), оно читается как { balance: N, lifetimeSpend: 0 }
   и при следующей записи преобразуется в новый формат.
   Независимое хранилище: не влияет на заказы напрямую, только через server.js.
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = require('./paths').DATA_DIR;
const FILE = path.join(DATA_DIR, 'loyalty.json');

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
    console.error('loyalty: не удалось прочитать loyalty.json —', e.message);
    return {};
  }
}

function writeAll(obj) {
  ensure();
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

/* Нормализует запись к виду { balance, lifetimeSpend, cardNo } независимо от старого формата.
   cardNo — короткий номер карты, который клиент может продиктовать (выдаётся ensureCard). */
function normalize(entry) {
  if (typeof entry === 'number') return { balance: entry, lifetimeSpend: 0, cardNo: '' };
  if (entry && typeof entry === 'object') {
    return {
      balance: Number(entry.balance) || 0,
      lifetimeSpend: Number(entry.lifetimeSpend) || 0,
      cardNo: entry.cardNo ? String(entry.cardNo) : ''
    };
  }
  return { balance: 0, lifetimeSpend: 0, cardNo: '' };
}

function getRecord(phone) {
  const k = key(phone);
  if (k.length < 5) return { balance: 0, lifetimeSpend: 0, cardNo: '' };
  return normalize(readAll()[k]);
}

/* Генерирует уникальный 6-значный номер карты — только цифры, легко продиктовать по телефону. */
function genCardNo(taken) {
  let no;
  do {
    no = String(Math.floor(100000 + Math.random() * 900000));
  } while (taken.indexOf(no) !== -1);
  return no;
}

/* Выдаёт клиенту номер карты, если у него его ещё нет (иначе возвращает как есть).
   Вызывается после первого успешного заказа — «пустых» карт без заказов не создаём. */
function ensureCard(phone) {
  const k = key(phone);
  if (k.length < 5) return { balance: 0, lifetimeSpend: 0, cardNo: '' };
  const all = readAll();
  const rec = normalize(all[k]);
  if (!rec.cardNo) {
    const taken = Object.keys(all).map(function (kk) { return normalize(all[kk]).cardNo; }).filter(Boolean);
    rec.cardNo = genCardNo(taken);
    all[k] = rec;
    writeAll(all);
  }
  return rec;
}

/* Найти клиента по номеру карты (сотрудник принимает заказ по телефону и клиент диктует номер). */
function findByCard(cardNo) {
  const want = String(cardNo || '').replace(/\D/g, '');
  if (!want) return null;
  const all = readAll();
  const foundKey = Object.keys(all).find(function (k) { return normalize(all[k]).cardNo === want; });
  if (!foundKey) return null;
  return Object.assign({ phone: foundKey }, normalize(all[foundKey]));
}

/* Список всех карт — для раздела «Карты» в админке. */
function listAll() {
  const all = readAll();
  return Object.keys(all).map(function (k) {
    return Object.assign({ phone: k }, normalize(all[k]));
  }).filter(function (r) { return r.cardNo; }); // без выданной карты клиент в списке не нужен
}

/* Ручная корректировка баланса администратором (не трогает lifetimeSpend — это не заказ).
   delta может быть отрицательным. Возвращает новый баланс. */
function adjustBalance(phone, delta) {
  const k = key(phone);
  const d = Math.round(Number(delta) || 0);
  if (k.length < 5 || d === 0) return get(phone);
  const all = readAll();
  const rec = normalize(all[k]);
  rec.balance = Math.max(0, rec.balance + d);
  all[k] = rec;
  writeAll(all);
  return rec.balance;
}

/* Баланс по телефону (для обратной совместимости). */
function get(phone) {
  return getRecord(phone).balance;
}

/* Выбирает уровень клиента: последний тир, чей minSpend <= lifetimeSpend.
   tiers — отсортированные по minSpend по возрастанию (сортируем сами на всякий случай). */
function tierFor(lifetimeSpend, tiers) {
  const list = (Array.isArray(tiers) ? tiers.slice() : [])
    .filter(function (t) { return t && t.name; })
    .sort(function (a, b) { return (Number(a.minSpend) || 0) - (Number(b.minSpend) || 0); });
  if (!list.length) return null;
  let current = list[0];
  for (let i = 0; i < list.length; i++) {
    if ((Number(list[i].minSpend) || 0) <= (Number(lifetimeSpend) || 0)) current = list[i];
  }
  return current;
}

/* Следующий уровень и сколько ₽ заказов до него осталось (для прогресс-бара на сайте). */
function nextTierInfo(lifetimeSpend, tiers) {
  const list = (Array.isArray(tiers) ? tiers.slice() : [])
    .filter(function (t) { return t && t.name; })
    .sort(function (a, b) { return (Number(a.minSpend) || 0) - (Number(b.minSpend) || 0); });
  const spend = Number(lifetimeSpend) || 0;
  const next = list.find(function (t) { return (Number(t.minSpend) || 0) > spend; });
  if (!next) return null;
  return { name: next.name, remaining: Math.max(0, Math.round((Number(next.minSpend) || 0) - spend)) };
}

/* Начислить баллы и учесть сумму заказа в lifetimeSpend (для роста уровня).
   points        — сколько баллов начислить (>= 0)
   orderSubtotal — сумма заказа (₽, до скидок), идёт в lifetimeSpend; необязательна.
   Возвращает новый баланс. */
function add(phone, points, orderSubtotal) {
  const k = key(phone);
  const p = Math.round(Number(points) || 0);
  const spend = Math.max(0, Math.round(Number(orderSubtotal) || 0));
  if (k.length < 5 || (p <= 0 && spend <= 0)) return get(phone);
  const all = readAll();
  const rec = normalize(all[k]);
  rec.balance += Math.max(0, p);
  rec.lifetimeSpend += spend;
  all[k] = rec;
  writeAll(all);
  return rec.balance;
}

/* Списать баллы (не уходим в минус). Возвращает фактически списанное число. */
function spend(phone, points) {
  const k = key(phone);
  const want = Math.round(Number(points) || 0);
  if (k.length < 5 || want <= 0) return 0;
  const all = readAll();
  const rec = normalize(all[k]);
  const take = Math.min(rec.balance, want);
  rec.balance -= take;
  all[k] = rec;
  writeAll(all);
  return take;
}

module.exports = { get, getRecord, add, spend, tierFor, nextTierInfo, ensureCard, findByCard, listAll, adjustBalance };
