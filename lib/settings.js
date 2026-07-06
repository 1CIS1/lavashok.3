/* ============================================================
   Настройки заведения (data/settings.json) — редактируются из админки.
   Сайт берёт телефон/адрес/часы и т.д. из /api/settings.
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = require('./paths').DATA_DIR;
const FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULTS = {
  brand: 'ЛавашОК',
  phone: '+7 (980) 531-33-12',
  address: 'г. Воронеж, ул. Плехановская, д. 2',
  hours: 'Ежедневно с 8:00 до 23:00',
  /* Координаты для карты и геоданных (Schema.org). Найти свои: yandex.ru/maps —
     клик по заведению → координаты в адресной строке (ll=долгота,широта). */
  lat: 51.657667,
  lng: 39.205272,
  /* Ключ Static Maps API — без него Яндекс не отдаёт картинку карты (проверено:
     с 2023х это обязательный параметр). Бесплатный ключ: yandex.ru/dev → "Static API".
     Без ключа на сайте вместо картинки будет просто кликабельная иконка-ссылка на карту. */
  yandexStaticApiKey: '',
  /* WhatsApp по умолчанию = основной телефон (частая практика для малого бизнеса) —
     проверьте и поправьте в админке, если у заведения отдельный WhatsApp-номер. */
  whatsapp: '79805313312',
  telegram: '',
  freeDeliveryFrom: 500,
  minOrder: 0,
  promoBanner: '',

  /* П.9 — приём заказов (стоп-кнопка в админке).
     ordersOpen=false → сайт временно не принимает заказы. */
  ordersOpen: true,
  ordersClosedMsg: 'Приём заказов временно приостановлен. Загляните чуть позже — скоро снова откроемся! 🌯',

  /* Расписание работы — автоматически закрывает приём заказов вне часов работы,
     в дополнение к ручной кнопке ordersOpen. Время — локальное время сервера, ЧЧ:ММ. */
  scheduleEnabled: false,
  scheduleOpen: '8:00',
  scheduleClose: '23:00',

  /* П.5 — зоны доставки (район · стоимость · мин. сумма · время).
     Редактируются в админке, показываются на сайте. */
  deliveryZones: [
    { name: 'Центр города', price: 0, minOrder: 500, time: '30–50 мин' },
    { name: 'Весь город (все районы)', price: 149, minOrder: 600, time: '40–70 мин' },
    { name: 'Пригород (до 15 км)', price: 299, minOrder: 1000, time: '60–90 мин' }
  ],

  /* П.7 — SEO (для попадания в топ поиска). */
  city: 'Воронеж',
  seoTitle: '',
  seoDescription: '',
  seoKeywords: '',

  /* Лояльность — бонусные баллы (по умолчанию выключено).
     loyaltyPercent оставлен для обратной совместимости со старыми настройками,
     но сайт теперь считает начисление по уровням (loyaltyTiers) — см. ниже.
     Уровень определяется по lifetimeSpend клиента (сумма всех его заказов). */
  loyaltyEnabled: false,
  loyaltyPercent: 5,
  loyaltyTiers: [
    { name: 'Новичок',      minSpend: 0,     percent: 5 },
    { name: 'Едок',         minSpend: 3000,  percent: 7 },
    { name: 'Прожора',      minSpend: 10000, percent: 10 },
    { name: 'Гуру шаурмы',  minSpend: 25000, percent: 15 }
  ],
  /* Сколько % от суммы заказа можно оплатить баллами (не сгорают, копятся бессрочно). */
  loyaltyRedeemMaxPercent: 30,

  /* SMS-уведомления клиенту при смене статуса (нужен ключ SMS.ru в env). */
  smsEnabled: false,
  /* Тексты SMS — {id} подставляется номером заказа. *Pickup — отдельный текст для самовывоза. */
  smsTemplates: {
    cooking: 'Ваш заказ #{id} готовится 🍳',
    delivering: 'Заказ #{id} передан курьеру 🛵 Скоро будет у вас!',
    deliveringPickup: 'Заказ #{id} готов к самовывозу 🏃 Ждём вас!',
    delivered: 'Заказ #{id} доставлен ✅ Спасибо, что выбрали нас!',
    deliveredPickup: 'Заказ #{id} выдан ✅ Спасибо, что выбрали нас!',
    canceled: 'Заказ #{id} отменён. Если это ошибка — позвоните нам.'
  },

  /* Целевое время готовки для экрана кухни (таймер/подсветка «просрочки»), в минутах. */
  kitchenTargetMin: 15,

  /* Предзаказ на самовывоз к выбранному времени (оплачивается онлайн).
     Работает только при настроенной ЮKassa. leadMin — минимум минут от «сейчас»
     до времени готовности; maxDays — на сколько дней вперёд можно заказать. */
  preorderEnabled: true,
  preorderLeadMin: 20,
  preorderMaxDays: 2
};

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, JSON.stringify(DEFAULTS, null, 2), 'utf8');
}

function get() {
  ensure();
  try {
    const raw = fs.readFileSync(FILE, 'utf8').trim();
    const obj = raw ? JSON.parse(raw) : {};
    return Object.assign({}, DEFAULTS, obj);
  } catch (e) {
    console.error('settings: не удалось прочитать settings.json —', e.message);
    return Object.assign({}, DEFAULTS);
  }
}

function save(patch) {
  const next = Object.assign({}, get(), patch || {});
  ensure();
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
  return next;
}

module.exports = { get, save, DEFAULTS };
