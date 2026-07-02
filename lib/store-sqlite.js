/* ============================================================
   Хранилище заказов в SQLite (data/orders.db) через better-sqlite3.
   API совпадает со store-json.js, поэтому server.js не зависит от драйвера.
   Если better-sqlite3 не установлен/не собрался — этот модуль бросит
   ошибку при require, и store.js автоматически переключится на JSON.
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = require('./paths').DATA_DIR;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'orders.db'));
db.pragma('journal_mode = WAL');
db.exec(
  'CREATE TABLE IF NOT EXISTS orders (' +
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,' +
  '  createdAt TEXT, updatedAt TEXT,' +
  '  name TEXT, phone TEXT, comment TEXT,' +
  '  items TEXT, total INTEGER DEFAULT 0,' +
  '  payment TEXT, paymentStatus TEXT, paymentId TEXT,' +
  '  status TEXT DEFAULT \'new\',' +
  '  notes TEXT,' +
  '  track TEXT, trackToken TEXT,' +
  '  subtotal INTEGER, discount INTEGER, promoCode TEXT,' +
  '  yandexClaimId TEXT, yandexTrackUrl TEXT, yandexStatus TEXT,' +
  '  utm TEXT, pageUrl TEXT, ip TEXT, userAgent TEXT' +
  ')'
);

/* Миграции для баз, созданных раньше (добавляем недостающие колонки). */
['notes', 'track', 'trackToken', 'subtotal', 'discount', 'promoCode', 'yandexClaimId', 'yandexTrackUrl', 'yandexStatus'].forEach(function (col) {
  try { db.exec('ALTER TABLE orders ADD COLUMN ' + col + ' TEXT'); } catch (e) { /* колонка уже есть */ }
});

function rowToOrder(r) {
  if (!r) return null;
  return Object.assign({}, r, {
    items: r.items ? safeParse(r.items, []) : [],
    utm: r.utm ? safeParse(r.utm, {}) : {}
  });
}
function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch (e) { return fallback; }
}

function list() {
  return db.prepare('SELECT * FROM orders ORDER BY id DESC').all().map(rowToOrder);
}

function getById(id) {
  return rowToOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(id)));
}

function add(o) {
  const now = new Date().toISOString();
  const info = db.prepare(
    'INSERT INTO orders ' +
    '(createdAt, updatedAt, name, phone, comment, items, total, subtotal, discount, promoCode, payment, paymentStatus, paymentId, status, track, trackToken, utm, pageUrl, ip, userAgent) ' +
    'VALUES (@createdAt,@updatedAt,@name,@phone,@comment,@items,@total,@subtotal,@discount,@promoCode,@payment,@paymentStatus,@paymentId,@status,@track,@trackToken,@utm,@pageUrl,@ip,@userAgent)'
  ).run({
    createdAt: now,
    updatedAt: now,
    name: o.name || '',
    phone: o.phone || '',
    comment: o.comment || '',
    items: JSON.stringify(o.items || []),
    total: o.total || 0,
    subtotal: o.subtotal || 0,
    discount: o.discount || 0,
    promoCode: o.promoCode || null,
    payment: o.payment || 'cash',
    paymentStatus: o.paymentStatus || 'not_required',
    paymentId: o.paymentId || null,
    status: 'new',
    track: o.track || 'accepted',
    trackToken: o.trackToken || null,
    utm: JSON.stringify(o.utm || {}),
    pageUrl: o.pageUrl || '',
    ip: o.ip || '',
    userAgent: o.userAgent || ''
  });
  return getById(info.lastInsertRowid);
}

function update(id, patch) {
  const cur = getById(id);
  if (!cur) return null;
  const cols = ['name', 'phone', 'comment', 'total', 'payment', 'paymentStatus', 'paymentId', 'status', 'notes', 'track', 'trackToken', 'yandexClaimId', 'yandexTrackUrl', 'yandexStatus'];
  const sets = [];
  const vals = { id: Number(id) };
  cols.forEach(function (k) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) { sets.push(k + ' = @' + k); vals[k] = patch[k]; }
  });
  if (Object.prototype.hasOwnProperty.call(patch, 'items')) {
    sets.push('items = @items'); vals.items = JSON.stringify(patch.items);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'utm')) {
    sets.push('utm = @utm'); vals.utm = JSON.stringify(patch.utm);
  }
  sets.push('updatedAt = @updatedAt'); vals.updatedAt = new Date().toISOString();
  db.prepare('UPDATE orders SET ' + sets.join(', ') + ' WHERE id = @id').run(vals);
  return getById(id);
}

function updateStatus(id, status) { return update(id, { status: status }); }

function stats() {
  const total = db.prepare('SELECT COUNT(*) AS c FROM orders').get().c;
  const byStatus = { new: 0, called: 0, done: 0, canceled: 0 };
  db.prepare('SELECT status, COUNT(*) AS c FROM orders GROUP BY status').all()
    .forEach(function (r) { byStatus[r.status] = r.c; });
  return { total: total, byStatus: byStatus };
}

module.exports = { list, add, getById, update, updateStatus, stats, driver: 'sqlite' };
