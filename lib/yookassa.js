/* ============================================================
   Интеграция с ЮKassa (YooKassa) — приём онлайн-платежей.
   Ключи берутся из переменных окружения и НЕ хранятся в коде:
     YOOKASSA_SHOP_ID      — идентификатор магазина
     YOOKASSA_SECRET_KEY   — секретный ключ
   Если ключи не заданы — онлайн-оплата выключена, сайт работает
   в режиме «оплата при получении».
   Документация: https://yookassa.ru/developers/api
   ============================================================ */
'use strict';

const crypto = require('crypto');

const SHOP_ID = process.env.YOOKASSA_SHOP_ID || '';
const SECRET_KEY = process.env.YOOKASSA_SECRET_KEY || '';
const API = 'https://api.yookassa.ru/v3';

function isConfigured() {
  return Boolean(SHOP_ID && SECRET_KEY);
}

function authHeader() {
  return 'Basic ' + Buffer.from(SHOP_ID + ':' + SECRET_KEY).toString('base64');
}

/* Создать платёж. Возвращает объект платежа ЮKassa,
   в т.ч. confirmation.confirmation_url — куда вести клиента. */
async function createPayment(opts) {
  const res = await fetch(API + '/payments', {
    method: 'POST',
    headers: {
      'Authorization': authHeader(),
      'Idempotence-Key': crypto.randomUUID(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      amount: { value: opts.amountValue, currency: 'RUB' },
      capture: true,
      confirmation: { type: 'redirect', return_url: opts.returnUrl },
      description: opts.description,
      metadata: opts.metadata || {}
    })
  });
  const data = await res.json().catch(function () { return {}; });
  if (!res.ok) {
    const err = new Error(data && data.description ? data.description : 'YooKassa: ошибка создания платежа');
    err.details = data;
    throw err;
  }
  return data;
}

/* Получить актуальный статус платежа по его id. */
async function getPayment(id) {
  const res = await fetch(API + '/payments/' + encodeURIComponent(id), {
    headers: { 'Authorization': authHeader() }
  });
  const data = await res.json().catch(function () { return {}; });
  if (!res.ok) throw new Error('YooKassa: ошибка получения платежа');
  return data;
}

/* Вернуть деньги клиенту по успешному платежу (полностью или частично). */
async function refund(paymentId, amountValue) {
  const res = await fetch(API + '/refunds', {
    method: 'POST',
    headers: {
      'Authorization': authHeader(),
      'Idempotence-Key': crypto.randomUUID(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      payment_id: paymentId,
      amount: { value: amountValue, currency: 'RUB' }
    })
  });
  const data = await res.json().catch(function () { return {}; });
  if (!res.ok) {
    const err = new Error(data && data.description ? data.description : 'YooKassa: ошибка возврата');
    err.details = data;
    throw err;
  }
  return data;
}

module.exports = { isConfigured: isConfigured, createPayment: createPayment, getPayment: getPayment, refund: refund };
