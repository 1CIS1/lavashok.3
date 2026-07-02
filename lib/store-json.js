/* ============================================================
   Хранилище заказов в JSON-файле (data/orders.json).
   Используется как запасной вариант, если SQLite недоступен.
   API совпадает со store-sqlite.js.
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = require('./paths').DATA_DIR;
const FILE = path.join(DATA_DIR, 'orders.json');

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, '[]', 'utf8');
}

function readAll() {
  ensure();
  try {
    const raw = fs.readFileSync(FILE, 'utf8').trim();
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('store-json: не удалось прочитать orders.json —', e.message);
    return [];
  }
}

function writeAll(list) {
  ensure();
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

function list() {
  return readAll().slice().sort(function (a, b) { return (b.id || 0) - (a.id || 0); });
}

function getById(id) {
  return readAll().find(function (o) { return o.id === Number(id); }) || null;
}

function add(order) {
  const all = readAll();
  const id = all.length
    ? Math.max.apply(null, all.map(function (o) { return o.id || 0; })) + 1
    : 1;
  const record = Object.assign({}, order, {
    id: id,
    status: 'new',
    createdAt: new Date().toISOString()
  });
  all.push(record);
  writeAll(all);
  return record;
}

function update(id, patch) {
  const all = readAll();
  const target = all.find(function (o) { return o.id === Number(id); });
  if (!target) return null;
  Object.assign(target, patch, { updatedAt: new Date().toISOString() });
  writeAll(all);
  return target;
}

function updateStatus(id, status) {
  return update(id, { status: status });
}

function stats() {
  const all = readAll();
  const byStatus = { new: 0, called: 0, done: 0, canceled: 0 };
  all.forEach(function (o) { byStatus[o.status] = (byStatus[o.status] || 0) + 1; });
  return { total: all.length, byStatus: byStatus };
}

module.exports = { list, add, getById, update, updateStatus, stats, driver: 'json' };
