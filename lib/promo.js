/* ============================================================
   Промокоды и акции (data/promos.json) — управляются из админки.
   Скидку всегда считает сервер (клиенту доверять нельзя).
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = require('./paths').DATA_DIR;
const FILE = path.join(DATA_DIR, 'promos.json');

const SEED = [
  { code: 'ПРИВЕТ', type: 'percent', value: 10, minOrder: 300, maxUses: 0, uses: 0, expires: '', active: true, label: 'Скидка 10% по промокоду ПРИВЕТ' }
];

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, JSON.stringify(SEED, null, 2), 'utf8');
}
function all() {
  ensure();
  try {
    const raw = fs.readFileSync(FILE, 'utf8').trim();
    const a = raw ? JSON.parse(raw) : [];
    return Array.isArray(a) ? a : [];
  } catch (e) { return []; }
}
function saveAll(list) {
  ensure();
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
  return all();
}
function norm(code) { return String(code || '').trim().toUpperCase(); }
function find(code) {
  const c = norm(code);
  return all().find(function (p) { return norm(p.code) === c; }) || null;
}

/* Проверить промокод для суммы корзины. Возвращает { ok, discount, code } или { ok:false, error }. */
function validate(code, subtotal) {
  const p = find(code);
  if (!p) return { ok: false, error: 'Промокод не найден' };
  if (p.active === false) return { ok: false, error: 'Промокод неактивен' };
  if (p.expires) {
    const d = new Date(p.expires);
    if (!isNaN(d) && Date.now() > d.getTime() + 86400000 - 1) return { ok: false, error: 'Срок промокода истёк' };
  }
  if (p.maxUses && Number(p.uses || 0) >= Number(p.maxUses)) return { ok: false, error: 'Лимит промокода исчерпан' };
  if (subtotal < Number(p.minOrder || 0)) {
    return { ok: false, error: 'Минимальная сумма для промокода: ' + Number(p.minOrder || 0) + ' ₽' };
  }
  let discount = p.type === 'percent'
    ? Math.round(subtotal * Number(p.value || 0) / 100)
    : Math.round(Number(p.value || 0));
  discount = Math.min(discount, subtotal);
  if (discount <= 0) return { ok: false, error: 'Промокод не даёт скидки' };
  return { ok: true, discount: discount, code: norm(p.code), label: p.label || '' };
}

function incrementUsage(code) {
  const c = norm(code);
  const list = all();
  let changed = false;
  list.forEach(function (p) { if (norm(p.code) === c) { p.uses = Number(p.uses || 0) + 1; changed = true; } });
  if (changed) saveAll(list);
}

module.exports = { all, saveAll, find, validate, incrementUsage, SEED };
