/* ============================================================
   SMS-уведомления клиенту через SMS.ru (по желанию).
   Включается переменной окружения SMS_RU_API_ID (ваш api_id из ЛК SMS.ru)
   И тумблером в админке (settings.smsEnabled). Без ключа — ничего не шлёт.

   Документация: https://sms.ru/api/send
   ============================================================ */
'use strict';

const API_ID = process.env.SMS_RU_API_ID || '';

function isConfigured() { return Boolean(API_ID); }

/* Отправить SMS. Возвращает Promise (ошибки гасятся — не ломают заказ). */
async function send(phone, text) {
  if (!isConfigured()) return { ok: false, error: 'SMS не настроены' };
  const to = String(phone || '').replace(/\D/g, '');
  if (to.length < 11) return { ok: false, error: 'Некорректный телефон' };
  try {
    const url = 'https://sms.ru/sms/send?api_id=' + encodeURIComponent(API_ID) +
      '&to=' + encodeURIComponent(to) +
      '&msg=' + encodeURIComponent(text) +
      '&json=1';
    const r = await fetch(url);
    const d = await r.json().catch(function () { return {}; });
    if (d && d.status === 'OK') return { ok: true };
    return { ok: false, error: (d && d.status_text) || 'Ошибка SMS.ru' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { isConfigured, send };
