/* ============================================================
   Интеграция с API Яндекс.Доставки (b2b cargo).
   Документация: https://yandex.ru/dev/logistics/ (Cargo Integration v2).

   Переменные окружения:
     YANDEX_DELIVERY_TOKEN   — OAuth-токен интеграции (Bearer)
     YANDEX_GEOCODER_KEY     — ключ Яндекс.Геокодера (для координат адреса клиента)
     YANDEX_PICKUP_ADDRESS   — адрес точки выдачи (вашей точки)
     YANDEX_PICKUP_LON       — долгота точки выдачи
     YANDEX_PICKUP_LAT       — широта точки выдачи
     YANDEX_PICKUP_CONTACT   — имя контакта на точке
     YANDEX_PICKUP_PHONE     — телефон точки

   ВНИМАНИЕ: точный формат заявки Cargo API может потребовать доработки под ваш
   аккаунт (класс тарифа, габариты, обязательные поля). Без ключей и без геокодера
   автосоздание заявки недоступно — используйте ручной ввод ссылки отслеживания.
   ============================================================ */
'use strict';

const crypto = require('crypto');

const TOKEN = process.env.YANDEX_DELIVERY_TOKEN || '';
const GEO_KEY = process.env.YANDEX_GEOCODER_KEY || '';
const API = process.env.YANDEX_DELIVERY_API || 'https://b2b.taxi.yandex.net';

const PICKUP = {
  address: process.env.YANDEX_PICKUP_ADDRESS || 'г. Москва, ул. Арбат, д. 24',
  lon: parseFloat(process.env.YANDEX_PICKUP_LON || ''),
  lat: parseFloat(process.env.YANDEX_PICKUP_LAT || ''),
  name: process.env.YANDEX_PICKUP_CONTACT || 'ЛавашОК',
  phone: process.env.YANDEX_PICKUP_PHONE || '+74951204567'
};

function isConfigured() { return Boolean(TOKEN); }

function headers() {
  return { 'Authorization': 'Bearer ' + TOKEN, 'Accept-Language': 'ru', 'Content-Type': 'application/json' };
}

/* Геокодирование адреса клиента в [lon, lat] через Яндекс.Геокодер. */
async function geocode(addressText) {
  if (!GEO_KEY || !addressText) return null;
  try {
    const url = 'https://geocode-maps.yandex.ru/1.x/?apikey=' + encodeURIComponent(GEO_KEY) +
      '&format=json&results=1&geocode=' + encodeURIComponent(addressText);
    const r = await fetch(url);
    const d = await r.json();
    const pos = d.response.GeoObjectCollection.featureMember[0].GeoObject.Point.pos; // "lon lat"
    const parts = pos.split(' ').map(Number);
    return [parts[0], parts[1]];
  } catch (e) {
    return null;
  }
}

/* Создать заявку на доставку. order — объект заказа из хранилища. */
async function createClaim(order) {
  if (!isConfigured()) throw new Error('Не задан YANDEX_DELIVERY_TOKEN');
  if (isNaN(PICKUP.lon) || isNaN(PICKUP.lat)) {
    throw new Error('Не заданы координаты точки выдачи (YANDEX_PICKUP_LON / YANDEX_PICKUP_LAT)');
  }
  const dest = await geocode(order.comment);
  if (!dest) throw new Error('Не удалось определить координаты адреса клиента (нужен YANDEX_GEOCODER_KEY и адрес в заказе)');

  const body = {
    items: [{
      title: 'Заказ #' + order.id + ' ЛавашОК',
      quantity: 1,
      cost_value: String(order.total || 0),
      cost_currency: 'RUB',
      weight: 1,
      size: { length: 0.25, width: 0.25, height: 0.2 }
    }],
    route_points: [
      {
        point_id: 1, visit_order: 1, type: 'source',
        address: { fullname: PICKUP.address, coordinates: [PICKUP.lon, PICKUP.lat] },
        contact: { name: PICKUP.name, phone: PICKUP.phone }
      },
      {
        point_id: 2, visit_order: 2, type: 'destination',
        address: { fullname: order.comment || '', coordinates: dest },
        contact: { name: order.name || 'Клиент', phone: order.phone || '' }
      }
    ],
    client_requirements: { taxi_class: 'express' },
    emergency_contact: { name: PICKUP.name, phone: PICKUP.phone }
  };

  const r = await fetch(API + '/b2b/cargo/integration/v2/claims/create?request_id=' + crypto.randomUUID(), {
    method: 'POST', headers: headers(), body: JSON.stringify(body)
  });
  const d = await r.json().catch(function () { return {}; });
  if (!r.ok) {
    const err = new Error(d && d.message ? d.message : ('Yandex create ' + r.status));
    err.details = d;
    throw err;
  }
  return d; // { id, status, sharing_url?, ... }
}

/* Получить актуальную информацию по заявке. */
async function getInfo(claimId) {
  if (!isConfigured()) throw new Error('Не задан YANDEX_DELIVERY_TOKEN');
  const r = await fetch(API + '/b2b/cargo/integration/v2/claims/info?claim_id=' + encodeURIComponent(claimId), {
    method: 'POST', headers: headers(), body: JSON.stringify({})
  });
  const d = await r.json().catch(function () { return {}; });
  if (!r.ok) throw new Error(d && d.message ? d.message : ('Yandex info ' + r.status));
  return d;
}

/* Извлечь ссылку отслеживания из ответа заявки (поля зависят от версии API). */
function extractTrackUrl(d) {
  if (!d) return '';
  if (d.sharing_url) return d.sharing_url;
  if (Array.isArray(d.route_points)) {
    for (let i = 0; i < d.route_points.length; i++) {
      const p = d.route_points[i];
      if (p && p.type === 'destination' && p.sharing_url) return p.sharing_url;
    }
  }
  return '';
}

/* Сопоставить статус Яндекса с нашими этапами трекинга. */
function mapStatus(yStatus) {
  const s = String(yStatus || '');
  if (/cancel|return|fail/i.test(s)) return 'canceled';
  if (/^delivered/i.test(s) || s === 'delivered_finish') return 'delivered';
  if (/pickuped|delivery_arrived|transporting/i.test(s)) return 'delivering';
  if (/performer_found|pickup_arrived|ready_for_pickup|accepted/i.test(s)) return 'cooking';
  return 'accepted';
}

module.exports = { isConfigured, createClaim, getInfo, extractTrackUrl, mapStatus, PICKUP };
