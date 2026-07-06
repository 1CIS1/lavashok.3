/* ============================================================
   ЛавашОК — backend на Express.
   • сайт + статика (favicon, og-image)
   • корзина и заказы:        POST /api/order   (валидация zod, антиспам)
   • конфиг фронтенда:        GET  /api/config
   • онлайн-оплата ЮKassa:    создаётся при payment=online
   • возврат/статус оплаты:   GET  /payment-return, /api/payment-status
   • вебхук ЮKassa:           POST /api/yookassa-webhook (проверка IP)
   • админка (сессии):        GET  /admin, /admin/login, ...
   Безопасность: helmet, сессии, bcrypt-хеш пароля, rate-limit.
   Запуск:  npm install  &&  npm start
   ============================================================ */
'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { z } = require('zod');
const XLSX = require('xlsx');

const store = require('./lib/store');
const SessionFileStore = require('./lib/sessionStore');
const menu = require('./lib/menu');
const settings = require('./lib/settings');
const promo = require('./lib/promo');
const yookassa = require('./lib/yookassa');
const yandex = require('./lib/yandex-delivery');
const loyalty = require('./lib/loyalty');
const customers = require('./lib/customers');
const sms = require('./lib/sms');

const app = express();
const PORT = process.env.PORT || 3000;
const FREE_DELIVERY_FROM = parseInt(process.env.FREE_DELIVERY_FROM || '500', 10);
const TRACK_STAGES = ['accepted', 'cooking', 'delivering', 'delivered', 'canceled'];

/* Человекочитаемый номер заказа: ДДММ-<id> (напр. 2806-7).
   Уникален и показывает день; считается из даты создания и id. */
function fmtOrderNo(order) {
  if (!order) return '';
  const d = order.createdAt ? new Date(order.createdAt) : new Date();
  const p = function (n) { return (n < 10 ? '0' : '') + n; };
  return p(d.getDate()) + p(d.getMonth() + 1) + '-' + order.id;
}

/* Дата в локальном времени сервера как YYYY-MM-DD — для отчётов «за день». */
function localDateKey(d) {
  const p = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/* Попадает ли момент d в часы работы (scheduleOpen–scheduleClose, локальное время сервера).
   Используется и для «приём открыт сейчас», и для проверки времени предзаказа. */
function isTimeInSchedule(d, s) {
  const parse = function (t) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
    return m ? (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) : null;
  };
  const open = parse(s.scheduleOpen);
  const close = parse(s.scheduleClose);
  if (open == null || close == null || open === close) return true; // не задано/некорректно — не блокируем
  const mins = d.getHours() * 60 + d.getMinutes();
  if (open < close) return mins >= open && mins < close;
  return mins >= open || mins < close; // расписание через полночь, напр. 10:00–02:00
}

/* Приём заказов открыт: ручная кнопка (ordersOpen) И, если включено расписание,
   текущее время сервера попадает в часы работы. */
function isOrdersOpenNow(s) {
  if (s.ordersOpen === false) return false;
  if (s.scheduleEnabled !== true) return true;
  return isTimeInSchedule(new Date(), s);
}

/* Параметры предзаказа с защитой от мусора в настройках.
   onlineOnly: если ЮKassa настроена — предзаказ строго с предоплатой;
   без неё разрешаем оплату при получении (иначе фича недоступна вовсе). */
function preorderConf(s) {
  return {
    enabled: s.preorderEnabled !== false,
    onlineOnly: yookassa.isConfigured(),
    leadMin: Math.min(Math.max(parseInt(s.preorderLeadMin, 10) || 20, 10), 240),
    maxDays: Math.min(Math.max(parseInt(s.preorderMaxDays, 10) || 2, 1), 7)
  };
}

/* ── Конфигурация безопасности ───────────────────────────── */
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS_HASH = process.env.ADMIN_PASS_HASH ||
  bcrypt.hashSync(process.env.ADMIN_PASS || 'lavashok', 10);
const USING_DEFAULT_PASS = !process.env.ADMIN_PASS_HASH &&
  (!process.env.ADMIN_PASS || process.env.ADMIN_PASS === 'lavashok');
function getOrCreateSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  // секрет не задан в env — сохраняем сгенерированный один раз в файл,
  // чтобы он не менялся при каждом перезапуске процесса
  // (иначе все выданные ранее сессионные cookie сразу становятся недействительны)
  const dataDir = require('./lib/paths').DATA_DIR;
  const file = path.join(dataDir, '.session-secret');
  try {
    if (fs.existsSync(file)) {
      const saved = fs.readFileSync(file, 'utf8').trim();
      if (saved) return saved;
    }
  } catch (e) { /* игнор — сгенерируем новый ниже */ }
  const generated = crypto.randomBytes(32).toString('hex');
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, generated, 'utf8');
  } catch (e) {
    console.error('SESSION_SECRET: не удалось сохранить в файл —', e.message);
  }
  return generated;
}
const SESSION_SECRET = getOrCreateSessionSecret();
const IS_HTTPS = /^https:/i.test(process.env.PUBLIC_URL || '');

app.set('trust proxy', true);

/* Gzip/brotli-сжатие ответов — страницы (index.html, kitchen.html) отдаются
   в разы меньшим размером, статике и API это тоже не мешает. */
app.use(compression());

/* Заголовки безопасности. CSP разрешает inline-стили/скрипты,
   т.к. вёрстка и JS встроены в HTML; домены Яндекс.Метрики — на будущее. */
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", "'unsafe-inline'", 'https://mc.yandex.ru'],
      'script-src-attr': ["'unsafe-inline'"],   // разрешаем inline-обработчики onclick=...
      /* fonts.googleapis.com обязателен: без него Google Fonts блокируются и сайт падает на системный шрифт */
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
      'img-src': ["'self'", 'data:', 'https:'],
      'connect-src': ["'self'", 'https://mc.yandex.ru'],
      'form-action': ["'self'"],
      /* yandex.ru — для встроенной карты (виджет Яндекс.Карт в контактах) */
      'frame-src': ["'self'", 'https://yookassa.ru', 'https://yoomoney.ru', 'https://yandex.ru'],
      'upgrade-insecure-requests': null
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: true, limit: '64kb' }));

app.use(session({
  name: 'lavashok.sid',
  store: new SessionFileStore(),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: IS_HTTPS, maxAge: 1000 * 60 * 60 * 8 }
}));

/* Статика публичных ассетов: /favicon.svg, /og-image.svg. */
app.use(express.static(path.join(__dirname, 'assets'), { index: false }));
app.use('/img', express.static(path.join(__dirname, 'img')));

/* Загруженные фото блюд хранятся в data/uploads (переживают пересборку контейнера). */
const UPLOAD_DIR = path.join(require('./lib/paths').DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: function (req, file, cb) { cb(null, UPLOAD_DIR); },
    filename: function (req, file, cb) {
      const ext = (path.extname(file.originalname || '') || '.jpg').toLowerCase().slice(0, 6);
      cb(null, Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex') + ext);
    }
  }),
  limits: { fileSize: 4 * 1024 * 1024 }, // до 4 МБ
  fileFilter: function (req, file, cb) {
    cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype));
  }
});

/* ── Вспомогательное ─────────────────────────────────────── */
function isValidPhone(phone) {
  return String(phone || '').replace(/\D/g, '').length >= 11;
}
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .toString().split(',')[0].trim();
}

/* Универсальный счётчик попыток по ключу (IP) для rate-limit. */
function makeLimiter(windowMs, max) {
  const hits = new Map();
  return function (key) {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter(function (t) { return now - t < windowMs; });
    arr.push(now);
    hits.set(key, arr);
    return arr.length <= max;
  };
}
const orderLimit = makeLimiter(10 * 60 * 1000, 6);   // 6 заказов / 10 мин с IP
const trackLookupLimit = makeLimiter(10 * 60 * 1000, 15); // 15 попыток поиска заказа / 10 мин с IP

/* Анти-брутфорс входа: после 5 неудач — прогрессивная блокировка по IP. */
const loginFails = new Map();
function loginBlockedSec(ip) {
  const e = loginFails.get(ip);
  if (e && e.lockUntil > Date.now()) return Math.ceil((e.lockUntil - Date.now()) / 1000);
  return 0;
}
function loginFail(ip) {
  const e = loginFails.get(ip) || { count: 0, lockUntil: 0 };
  e.count++;
  if (e.count >= 5) {
    const lockSec = Math.min(30 * Math.pow(2, e.count - 5), 900); // 30с,60,120… до 15 мин
    e.lockUntil = Date.now() + lockSec * 1000;
  }
  loginFails.set(ip, e);
}
function loginReset(ip) { loginFails.delete(ip); }

/* Анти-брутфорс входа в личный кабинет клиента — отдельный счётчик по IP. */
const custLoginFails = new Map();
function custLoginBlockedSec(ip) {
  const e = custLoginFails.get(ip);
  if (e && e.lockUntil > Date.now()) return Math.ceil((e.lockUntil - Date.now()) / 1000);
  return 0;
}
function custLoginFail(ip) {
  const e = custLoginFails.get(ip) || { count: 0, lockUntil: 0 };
  e.count++;
  if (e.count >= 5) {
    const lockSec = Math.min(30 * Math.pow(2, e.count - 5), 900);
    e.lockUntil = Date.now() + lockSec * 1000;
  }
  custLoginFails.set(ip, e);
}
function custLoginReset(ip) { custLoginFails.delete(ip); }
const registerLimit = makeLimiter(60 * 60 * 1000, 10); // 10 регистраций/час с одного IP

/* Сессионная авторизация админа. */
function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  if (req.path.indexOf('/api/') === 0) return res.status(401).json({ ok: false, error: 'auth' });
  return res.redirect('/admin/login');
}

/* Сессионная авторизация клиента (личный кабинет) — отдельный флаг сессии, не пересекается с admin. */
function requireCustomer(req, res, next) {
  if (req.session && req.session.customerPhone) return next();
  return res.status(401).json({ ok: false, error: 'auth' });
}

/* Проверка, что вебхук пришёл с IP ЮKassa. */
const YOOKASSA_IPS = [
  '185.71.76.0/27', '185.71.77.0/27', '77.75.153.0/25',
  '77.75.156.11', '77.75.156.35', '77.75.154.128/25', '2a02:5180::/32'
];
function ipv4ToInt(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(function (x) { return isNaN(x); })) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
function ipAllowed(ip, list) {
  const norm = String(ip || '').replace(/^::ffff:/, '');
  if (norm.indexOf(':') !== -1) return true; // IPv6 не проверяем строго
  const ipi = ipv4ToInt(norm);
  if (ipi == null) return false;
  return list.some(function (entry) {
    if (entry.indexOf(':') !== -1) return false;
    if (entry.indexOf('/') === -1) return entry === norm;
    const parts = entry.split('/');
    const baseI = ipv4ToInt(parts[0]);
    const bits = Number(parts[1]);
    if (baseI == null) return false;
    const mask = bits === 0 ? 0 : (~((1 << (32 - bits)) - 1)) >>> 0;
    return (ipi & mask) === (baseI & mask);
  });
}

/* ── Real-time (Server-Sent Events) ──────────────────────── */
let adminClients = [];          // [res]
let trackClients = [];          // [{ res, token }]

function sseInit(res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  if (res.flushHeaders) res.flushHeaders();
  res.write('retry: 5000\n\n');
}
function sseSend(res, event, data) {
  try { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch (e) { /* закрыт */ }
}

function trackPayload(order) {
  return {
    id: order.id,
    orderNo: fmtOrderNo(order),
    track: order.track || 'accepted',
    total: order.total,
    itemsCount: (order.items || []).reduce(function (s, i) { return s + (i.qty || 0); }, 0),
    createdAt: order.createdAt,
    payment: order.payment,
    fulfillment: order.fulfillment || 'delivery',
    preorderAt: order.preorderAt || '',
    yandexTrackUrl: order.yandexTrackUrl || ''
  };
}

/* Оповестить о любом изменении заказа: админку (рефреш) и окно клиента (статус). */
function notifyOrderChanged(order) {
  if (!order) return;
  adminClients.forEach(function (res) { sseSend(res, 'orders', { id: order.id }); });
  if (order.trackToken) {
    trackClients.forEach(function (c) {
      if (c.token === order.trackToken) sseSend(c.res, 'update', trackPayload(order));
    });
  }
}

app.get('/api/admin/stream', requireAdmin, function (req, res) {
  sseInit(res);
  adminClients.push(res);
  const ping = setInterval(function () { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
  req.on('close', function () { clearInterval(ping); adminClients = adminClients.filter(function (r) { return r !== res; }); });
});

app.get('/api/track/stream', function (req, res) {
  const token = String(req.query.t || '');
  sseInit(res);
  const client = { res: res, token: token };
  trackClients.push(client);
  const ping = setInterval(function () { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
  req.on('close', function () { clearInterval(ping); trackClients = trackClients.filter(function (c) { return c !== client; }); });
});

/* ── Публичный сайт ──────────────────────────────────────── */
/* Плейсхолдер https://ВАШ-ДОМЕН в OG-тегах подменяем реальным доменом
   (PUBLIC_URL или хост запроса) — превью ссылок в мессенджерах работает сразу. */
let indexHtmlCache = null;
app.get('/', function (req, res) {
  const base = (process.env.PUBLIC_URL || (req.protocol + '://' + req.get('host'))).replace(/\/+$/, '');
  try {
    if (!indexHtmlCache || process.env.NODE_ENV !== 'production') {
      indexHtmlCache = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    }
    res.type('html').send(indexHtmlCache.split('https://ВАШ-ДОМЕН').join(base));
  } catch (e) {
    res.sendFile(path.join(__dirname, 'index.html'));
  }
});

/* Публичная оферта (ссылка из футера). Текст-шаблон — заполните реквизиты. */
app.get('/oferta', function (req, res) {
  res.sendFile(path.join(__dirname, 'oferta.html'));
});

app.get('/api/config', function (req, res) {
  const s = settings.get();
  const pre = preorderConf(s);
  res.json({
    ok: true,
    onlinePayment: yookassa.isConfigured(),
    freeDeliveryFrom: Number(s.freeDeliveryFrom) || FREE_DELIVERY_FROM,
    yandexDelivery: yandex.isConfigured(),
    ordersOpen: isOrdersOpenNow(s),                                       // П.9 + расписание
    ordersClosedMsg: s.ordersClosedMsg || '',                             // П.9
    loyaltyEnabled: s.loyaltyEnabled === true,                            // лояльность
    loyaltyPercent: Number(s.loyaltyPercent) || 0,
    /* предзаказ на самовывоз + окно работы для построения слотов на клиенте */
    preorderEnabled: pre.enabled,
    preorderOnlineOnly: pre.onlineOnly,
    preorderLeadMin: pre.leadMin,
    preorderMaxDays: pre.maxDays,
    scheduleEnabled: s.scheduleEnabled === true,
    scheduleOpen: s.scheduleOpen || '',
    scheduleClose: s.scheduleClose || ''
  });
});

/* Баланс бонусов и уровень клиента по телефону (если лояльность включена). */
app.get('/api/loyalty', function (req, res) {
  const s = settings.get();
  if (s.loyaltyEnabled !== true) return res.json({ ok: true, enabled: false, points: 0 });
  const phone = String(req.query.phone || '').replace(/\D/g, '');
  if (phone.length < 11) return res.json({ ok: true, enabled: true, points: 0 });
  const rec = loyalty.getRecord(phone);
  const tier = loyalty.tierFor(rec.lifetimeSpend, s.loyaltyTiers) || { name: '', percent: Number(s.loyaltyPercent) || 0 };
  const next = loyalty.nextTierInfo(rec.lifetimeSpend, s.loyaltyTiers);
  res.json({
    ok: true,
    enabled: true,
    points: rec.balance,
    percent: Number(tier.percent) || 0,
    tierName: tier.name || '',
    cardNo: rec.cardNo || '',
    nextTierName: next ? next.name : '',
    nextTierRemaining: next ? next.remaining : 0,
    redeemMaxPercent: Number(s.loyaltyRedeemMaxPercent) || 0
  });
});

/* ── Личный кабинет клиента (телефон — логин, пароль свой) ──
   Кабинет показывает только карту/баллы и историю заказов клиента.
   Регистрация сразу выдаёт карту (как и первый заказ) — это тоже способ
   «завести карту» самостоятельно, без похода в админку. */
app.post('/api/account/register', function (req, res) {
  const ip = clientIp(req);
  if (!registerLimit(ip)) {
    return res.status(429).json({ ok: false, error: 'Слишком много попыток. Попробуйте позже.' });
  }
  const phone = String((req.body && req.body.phone) || '').trim();
  const password = String((req.body && req.body.password) || '');
  if (!isValidPhone(phone)) return res.status(400).json({ ok: false, error: 'Некорректный номер телефона' });
  if (password.length < 4) return res.status(400).json({ ok: false, error: 'Пароль — минимум 4 символа' });
  const digits = phone.replace(/\D/g, '');
  if (customers.exists(digits)) {
    return res.status(400).json({ ok: false, error: 'Аккаунт с этим номером уже есть — войдите' });
  }
  try {
    customers.create(digits, password);
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'Не удалось создать аккаунт' });
  }
  const cardNo = loyalty.ensureCard(digits).cardNo;
  req.session.regenerate(function (err) {
    if (err) return res.status(500).json({ ok: false, error: 'Ошибка сервера' });
    req.session.customerPhone = digits;
    req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 90; // 90 дней — кабинет «помнит» клиента
    res.json({ ok: true, phone: digits, cardNo: cardNo });
  });
});

app.post('/api/account/login', function (req, res) {
  const ip = clientIp(req);
  const wait = custLoginBlockedSec(ip);
  if (wait) return res.status(429).json({ ok: false, error: 'Слишком много попыток. Подождите ' + wait + ' сек.' });
  const phone = String((req.body && req.body.phone) || '').trim();
  const password = String((req.body && req.body.password) || '');
  const digits = phone.replace(/\D/g, '');
  if (customers.verify(digits, password)) {
    custLoginReset(ip);
    return req.session.regenerate(function (err) {
      if (err) return res.status(500).json({ ok: false, error: 'Ошибка сервера' });
      req.session.customerPhone = digits;
      req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 90;
      res.json({ ok: true, phone: digits });
    });
  }
  custLoginFail(ip);
  res.status(401).json({ ok: false, error: 'Неверный телефон или пароль' });
});

app.post('/api/account/logout', function (req, res) {
  if (req.session) delete req.session.customerPhone;
  res.json({ ok: true });
});

/* Данные кабинета: карта, баллы, уровень + история заказов + текущий заказ + профиль.
   История — все заказы клиента (по телефону), последние 30: дата, состав, сумма.
   currentOrder — активный заказ (принят/готовится/в пути) с токеном трекинга,
   чтобы вкладка «Текущий заказ» в кабинете показывала статус в реальном времени.
   profile — имя/адрес/комментарий из последнего заказа для автозаполнения формы. */
app.get('/api/account/me', requireCustomer, function (req, res) {
  const digits = req.session.customerPhone;
  const s = settings.get();
  const rec = loyalty.getRecord(digits);
  const tier = loyalty.tierFor(rec.lifetimeSpend, s.loyaltyTiers) || { name: '', percent: Number(s.loyaltyPercent) || 0 };
  const next = loyalty.nextTierInfo(rec.lifetimeSpend, s.loyaltyTiers);

  const my = store.list().filter(function (o) {
    return String(o.phone || '').replace(/\D/g, '') === digits;
  }); // store.list() уже отсортирован: новые сверху

  const history = my.slice(0, 30).map(function (o) {
    return {
      id: o.id,
      orderNo: fmtOrderNo(o),
      createdAt: o.createdAt,
      total: o.total,
      itemsCount: (o.items || []).reduce(function (s2, i) { return s2 + (i.qty || 0); }, 0),
      items: (o.items || []).map(function (i) { return { name: i.name, qty: i.qty }; }),
      payment: o.payment,
      status: o.status,
      track: o.track || 'accepted',
      fulfillment: o.fulfillment || 'delivery',
      pointsUsed: o.pointsUsed || 0,
      pointsEarned: o.pointsEarned || 0
    };
  });

  /* Активный заказ для вкладки «Текущий заказ» (свой токен клиенту отдавать безопасно).
     Если активного нет — показываем выданный/доставленный СЕГОДНЯ заказ,
     чтобы клиент увидел финальный статус «Заказ выдан», открыв кабинет. */
  const activeStages = ['accepted', 'cooking', 'delivering'];
  let cur = my.find(function (o) {
    return activeStages.indexOf(o.track || 'accepted') !== -1 && o.status !== 'canceled';
  });
  if (!cur) {
    const todayKey = localDateKey(new Date());
    cur = my.find(function (o) {
      return (o.track || '') === 'delivered' && o.createdAt && localDateKey(new Date(o.createdAt)) === todayKey;
    });
  }

  /* Профиль для автозаполнения формы заказа — из последних заказов клиента.
     Служебную приписку «[Зона доставки: …]» из комментария убираем. */
  const lastNamed = my.find(function (o) { return o.name; });
  const lastCommented = my.find(function (o) { return o.comment; });
  const cleanComment = lastCommented
    ? String(lastCommented.comment).replace(/\n?\[Зона доставки:[^\]]*\]/g, '').trim()
    : '';

  res.json({
    ok: true,
    phone: digits,
    cardNo: rec.cardNo || '',
    points: rec.balance,
    tierName: tier.name || '',
    percent: Number(tier.percent) || 0,
    nextTierName: next ? next.name : '',
    nextTierRemaining: next ? next.remaining : 0,
    history: history,
    currentOrder: cur ? Object.assign({ token: cur.trackToken || '' }, trackPayload(cur)) : null,
    profile: {
      name: lastNamed ? lastNamed.name : '',
      phone: digits,
      lastComment: cleanComment
    }
  });
});

/* robots.txt — что можно индексировать поисковикам (П.7). */
app.get('/robots.txt', function (req, res) {
  const base = (process.env.PUBLIC_URL || (req.protocol + '://' + req.get('host'))).replace(/\/+$/, '');
  res.type('text/plain').send(
    'User-agent: *\n' +
    'Allow: /\n' +
    'Disallow: /admin\n' +
    'Disallow: /kitchen\n' +
    'Disallow: /api/\n\n' +
    'Sitemap: ' + base + '/sitemap.xml\n'
  );
});

/* sitemap.xml — карта сайта для поисковиков (П.7). */
app.get('/sitemap.xml', function (req, res) {
  const base = (process.env.PUBLIC_URL || (req.protocol + '://' + req.get('host'))).replace(/\/+$/, '');
  const today = new Date().toISOString().slice(0, 10);
  res.type('application/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    '  <url><loc>' + base + '/</loc><lastmod>' + today + '</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>\n' +
    '  <url><loc>' + base + '/privacy</loc><lastmod>' + today + '</lastmod><changefreq>monthly</changefreq><priority>0.2</priority></url>\n' +
    '  <url><loc>' + base + '/oferta</loc><lastmod>' + today + '</lastmod><changefreq>monthly</changefreq><priority>0.2</priority></url>\n' +
    '</urlset>\n'
  );
});

/* Публичные настройки заведения для сайта. */
app.get('/api/settings', function (req, res) {
  res.json({ ok: true, settings: settings.get() });
});

/* Публичное меню для витрины сайта. */
app.get('/api/menu', function (req, res) {
  res.json({ ok: true, items: menu.publicList(), categories: menu.CATEGORIES });
});

/* Проверка промокода (превью скидки). Сумма считается по меню на сервере. */
app.post('/api/promo/check', function (req, res) {
  const b = req.body || {};
  const rawItems = Array.isArray(b.items) ? b.items : [];
  let subtotal = 0;
  rawItems.forEach(function (it) {
    const m = menu.byId(it && it.id);
    const qty = Math.min(Math.max(parseInt(it && it.qty, 10) || 0, 1), 99);
    if (m) subtotal += m.price * qty;
  });
  const r = promo.validate(b.code, subtotal);
  if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
  res.json({ ok: true, discount: r.discount, code: r.code, label: r.label, subtotal: subtotal, total: subtotal - r.discount });
});

/* Схема валидации заказа. */
const orderSchema = z.object({
  name: z.string().max(200).optional().default(''),
  phone: z.string().min(1).max(40),
  comment: z.string().max(2000).optional().default(''),
  payment: z.enum(['cash', 'online']).optional().default('cash'),
  fulfillment: z.enum(['delivery', 'pickup']).optional().default('delivery'), // способ получения
  preorderAt: z.string().max(40).optional().default(''),  // предзаказ: ISO-время готовности (только самовывоз)
  items: z.array(z.object({
    id: z.string().max(60),
    qty: z.coerce.number().int().min(1).max(99)
  })).max(50).optional().default([]),
  website: z.string().max(200).optional().default(''),   // honeypot
  promoCode: z.string().max(40).optional().default(''),
  zone: z.string().max(80).optional().default(''),       // выбранная зона доставки
  pointsToUse: z.coerce.number().int().min(0).max(1000000).optional().default(0), // списание бонусов
  utm_source: z.string().max(200).optional().default(''),
  utm_medium: z.string().max(200).optional().default(''),
  utm_campaign: z.string().max(200).optional().default(''),
  utm_content: z.string().max(200).optional().default(''),
  utm_term: z.string().max(200).optional().default(''),
  page_url: z.string().max(500).optional().default('')
}).strip();

app.post('/api/order', async function (req, res) {
  const parsed = orderSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'Проверьте корректность полей' });
  }
  const b = parsed.data;

  /* honeypot */
  if (String(b.website || '').trim() !== '') {
    return res.status(400).json({ ok: false, error: 'Заявка отклонена' });
  }

  /* П.9 — приём заказов выключен в админке (стоп-кнопка) или сейчас вне расписания работы */
  const st = settings.get();
  if (!isOrdersOpenNow(st)) {
    return res.status(403).json({ ok: false, error: st.ordersClosedMsg || 'Приём заказов временно приостановлен' });
  }

  /* rate limit */
  const ip = clientIp(req);
  if (!orderLimit(ip)) {
    return res.status(429).json({ ok: false, error: 'Слишком много заявок. Попробуйте через несколько минут.' });
  }

  const phone = String(b.phone || '').trim();
  if (!isValidPhone(phone)) {
    return res.status(400).json({ ok: false, error: 'Некорректный номер телефона' });
  }

  /* состав корзины — цены берём с сервера */
  const items = [];
  let total = 0;
  (b.items || []).forEach(function (it) {
    const m = menu.byId(it.id);
    if (!m) return;
    const qty = Math.min(Math.max(parseInt(it.qty, 10) || 0, 1), 99);
    const sum = m.price * qty;
    items.push({ id: m.id, name: m.name, price: m.price, qty: qty, sum: sum });
    total += sum;
  });

  /* Промокод: скидку считает сервер. */
  const subtotal = total;
  let discount = 0;
  let promoCode = '';
  if (b.promoCode) {
    const pr = promo.validate(b.promoCode, subtotal);
    if (pr.ok) { discount = pr.discount; promoCode = pr.code; }
  }
  total = subtotal - discount;

  /* Бонусные баллы: предварительный расчёт (списание фиксируем только когда заказ реально создан).
     Ограничено настройкой loyaltyRedeemMaxPercent от суммы заказа и текущим балансом клиента. */
  let pointsUsed = 0;
  if (st.loyaltyEnabled === true && b.pointsToUse > 0) {
    const balance = loyalty.get(phone);
    const maxByPercent = Math.floor(subtotal * (Number(st.loyaltyRedeemMaxPercent) || 0) / 100);
    pointsUsed = Math.max(0, Math.min(b.pointsToUse, maxByPercent, balance));
    total = Math.max(0, total - pointsUsed);
  }

  const payment = b.payment === 'online' ? 'online' : 'cash';
  if (payment === 'online') {
    if (!yookassa.isConfigured()) return res.status(400).json({ ok: false, error: 'Онлайн-оплата не настроена' });
    if (total <= 0) return res.status(400).json({ ok: false, error: 'Для онлайн-оплаты добавьте блюда в корзину' });
  }

  const fulfillment = b.fulfillment === 'pickup' ? 'pickup' : 'delivery';

  /* ── Предзаказ к времени: только самовывоз и только онлайн-оплата.
     Все проверки — на сервере, значениям с клиента не доверяем. ── */
  let preorderAt = '';
  if (b.preorderAt) {
    const pre = preorderConf(st);
    if (!pre.enabled) return res.status(400).json({ ok: false, error: 'Предзаказ сейчас недоступен' });
    if (fulfillment !== 'pickup') return res.status(400).json({ ok: false, error: 'Предзаказ доступен только для самовывоза' });
    if (pre.onlineOnly && payment !== 'online') return res.status(400).json({ ok: false, error: 'Предзаказ оплачивается онлайн' });
    const t = new Date(b.preorderAt);
    if (isNaN(t.getTime())) return res.status(400).json({ ok: false, error: 'Некорректное время предзаказа' });
    const nowTs = Date.now();
    /* минута форы на заполнение формы, чтобы валидный слот не «протух» на границе */
    if (t.getTime() < nowTs + (pre.leadMin - 1) * 60000) {
      return res.status(400).json({ ok: false, error: 'Самое раннее время — через ' + pre.leadMin + ' мин. Выберите слот позже.' });
    }
    /* горизонт: до конца дня (сегодня + maxDays), чтобы вечерние слоты последнего дня были доступны */
    const limit = new Date(nowTs);
    limit.setDate(limit.getDate() + pre.maxDays);
    limit.setHours(23, 59, 59, 999);
    if (t.getTime() > limit.getTime()) {
      return res.status(400).json({ ok: false, error: 'Предзаказ принимаем максимум на ' + pre.maxDays + ' дн. вперёд' });
    }
    if (st.scheduleEnabled === true && !isTimeInSchedule(t, st)) {
      return res.status(400).json({ ok: false, error: 'В выбранное время мы не работаем — выберите другой слот' });
    }
    preorderAt = t.toISOString();
  }

  /* Зона доставки (информативно) — дописываем в комментарий для оператора.
     При самовывозе зона не имеет смысла, даже если пришла с клиента — игнорируем. */
  let comment = b.comment.trim().slice(0, 2000);
  const zone = fulfillment === 'pickup' ? '' : String(b.zone || '').trim().slice(0, 80);
  if (zone) comment = (comment ? comment + '\n' : '') + '[Зона доставки: ' + zone + ']';

  const trackToken = crypto.randomBytes(8).toString('hex');
  const order = store.add({
    name: b.name.trim().slice(0, 120),
    phone: phone.slice(0, 40),
    comment: comment.slice(0, 2100),
    items: items,
    total: total,
    subtotal: subtotal,
    discount: discount,
    promoCode: promoCode,
    pointsUsed: pointsUsed,
    payment: payment,
    fulfillment: fulfillment,
    zone: zone,
    preorderAt: preorderAt,
    paymentStatus: payment === 'online' ? 'pending' : 'not_required',
    track: 'accepted',
    trackToken: trackToken,
    utm: {
      source: b.utm_source, medium: b.utm_medium, campaign: b.utm_campaign,
      content: b.utm_content, term: b.utm_term
    },
    pageUrl: b.page_url,
    ip: ip,
    userAgent: String(req.headers['user-agent'] || '').slice(0, 300)
  });

  console.log('🌯  Новый заказ #' + order.id + ': ' + (order.name || '—') + ' / ' + order.phone +
              ' · ' + total + ' ₽ · ' + (payment === 'online' ? 'онлайн' : 'при получении'));
  notifyOrderChanged(order);
  if (promoCode) promo.incrementUsage(promoCode);

  /* Бонусные баллы: фиксируем списание (посчитано выше) и начисление за этот заказ.
     Уровень (тир) берём по накопленному ДО этого заказа — начисляем на итог с учётом
     уже применённых скидки и списанных баллов, чтобы нельзя было накрутить баллы баллами.
     Заодно выдаём клиенту номер карты, если это его первый заказ — карту без заказов не выдаём. */
  let cardNo = '';
  let pointsEarned = 0;
  try {
    if (st.loyaltyEnabled === true) {
      if (pointsUsed > 0) loyalty.spend(phone, pointsUsed);
      const rec = loyalty.getRecord(phone);
      const tier = loyalty.tierFor(rec.lifetimeSpend, st.loyaltyTiers) || { percent: Number(st.loyaltyPercent) || 0 };
      pointsEarned = Math.round(Math.max(0, total) * (Number(tier.percent) || 0) / 100);
      loyalty.add(phone, pointsEarned, subtotal);
      cardNo = loyalty.ensureCard(phone).cardNo;
      store.update(order.id, { pointsEarned: pointsEarned }); // для истории в личном кабинете
    }
  } catch (e) { console.error('loyalty:', e.message); }

  if (payment === 'online') {
    try {
      const base = (process.env.PUBLIC_URL || (req.protocol + '://' + req.get('host'))).replace(/\/+$/, '');
      const p = await yookassa.createPayment({
        amountValue: total.toFixed(2),
        description: 'Заказ #' + order.id + ' — ЛавашОК',
        returnUrl: base + '/payment-return?order=' + order.id,
        metadata: { orderId: String(order.id) }
      });
      store.update(order.id, { paymentId: p.id, paymentStatus: p.status || 'pending' });
      const url = p.confirmation && p.confirmation.confirmation_url;
      if (!url) throw new Error('Нет ссылки на оплату');
      return res.json({ ok: true, id: order.id, orderNo: fmtOrderNo(order), paymentUrl: url, track: trackToken, pointsUsed: pointsUsed, pointsEarned: pointsEarned, cardNo: cardNo });
    } catch (e) {
      console.error('YooKassa:', e.message);
      store.update(order.id, { paymentStatus: 'error' });
      return res.status(502).json({ ok: false, error: 'Не удалось создать онлайн-платёж. Попробуйте оплату при получении.' });
    }
  }

  res.json({ ok: true, id: order.id, orderNo: fmtOrderNo(order), track: trackToken, pointsUsed: pointsUsed, pointsEarned: pointsEarned, cardNo: cardNo });
});

app.get('/payment-return', function (req, res) {
  res.sendFile(path.join(__dirname, 'payment-return.html'));
});

app.get('/privacy', function (req, res) {
  res.sendFile(path.join(__dirname, 'privacy.html'));
});

/* Публичный трекинг заказа по токену. Отдельная страница track.html упразднена:
   отслеживание живёт в личном кабинете на главной — старые ссылки (SMS, закладки)
   редиректим на главную с параметром, который открывает панель «Текущий заказ». */
app.get('/track', function (req, res) {
  const t = String(req.query.t || '');
  res.redirect('/?track=' + encodeURIComponent(t));
});
app.get('/api/track', function (req, res) {
  const t = String(req.query.t || '');
  if (!t) return res.status(400).json({ ok: false, error: 'Нет кода заказа' });
  const order = store.list().find(function (o) { return o.trackToken === t; });
  if (!order) return res.status(404).json({ ok: false, error: 'Заказ не найден' });
  res.json(Object.assign({ ok: true }, trackPayload(order)));
});

/* Поиск заказа клиентом по номеру + телефону (телефон в теле, не в URL).
   Номера заказов последовательные — без лимита это позволило бы перебором
   найти заказ по известному телефону и получить чужую ссылку трекинга. */
app.post('/api/track-lookup', function (req, res) {
  if (!trackLookupLimit(clientIp(req))) {
    return res.status(429).json({ ok: false, error: 'Слишком много попыток. Попробуйте позже.' });
  }
  const id = String((req.body && req.body.id) || '').replace(/\D/g, '');
  const phone = String((req.body && req.body.phone) || '').replace(/\D/g, '');
  if (!id || phone.length < 5) {
    return res.status(400).json({ ok: false, error: 'Укажите номер заказа и телефон' });
  }
  const order = store.getById(id);
  const orderPhone = order ? String(order.phone || '').replace(/\D/g, '') : '';
  if (!order || !orderPhone || orderPhone.slice(-10) !== phone.slice(-10)) {
    return res.status(404).json({ ok: false, error: 'Заказ не найден. Проверьте номер и телефон.' });
  }
  res.json({ ok: true, token: order.trackToken });
});

app.get('/api/payment-status', async function (req, res) {
  const order = store.getById(req.query.order);
  if (!order) return res.status(404).json({ ok: false, error: 'Заказ не найден' });

  if (order.paymentId && yookassa.isConfigured() &&
      order.paymentStatus !== 'succeeded' && order.paymentStatus !== 'canceled') {
    try {
      const p = await yookassa.getPayment(order.paymentId);
      if (p && p.status) notifyOrderChanged(store.update(order.id, { paymentStatus: p.status }));
      return res.json({ ok: true, status: p.status, paid: p.paid === true, total: order.total });
    } catch (e) {
      return res.json({ ok: true, status: order.paymentStatus, total: order.total });
    }
  }
  res.json({ ok: true, status: order.paymentStatus, total: order.total });
});

app.post('/api/yookassa-webhook', function (req, res) {
  /* Проверяем источник: вебхук должен приходить с IP ЮKassa.
     Отключить (например, для теста) можно WEBHOOK_VERIFY=off. */
  if (process.env.WEBHOOK_VERIFY !== 'off' && yookassa.isConfigured()) {
    if (!ipAllowed(clientIp(req), YOOKASSA_IPS)) {
      console.warn('Webhook отклонён: чужой IP', clientIp(req));
      return res.status(403).json({ ok: false });
    }
  }
  const obj = req.body && req.body.object;
  if (obj && obj.metadata && obj.metadata.orderId) {
    const updated = store.update(obj.metadata.orderId, { paymentStatus: obj.status });
    console.log('ЮKassa webhook: заказ #' + obj.metadata.orderId + ' → ' + obj.status);
    /* будим кухню/админку по SSE — оплаченный предзаказ сразу виден в ленте */
    notifyOrderChanged(updated);
  }
  res.json({ ok: true });
});

/* ── Админка (сессии) ────────────────────────────────────── */
app.get('/admin/login', function (req, res) {
  if (req.session && req.session.admin) return res.redirect('/kitchen');
  res.sendFile(path.join(__dirname, 'admin-login.html'));
});

app.post('/admin/login', function (req, res) {
  const ip = clientIp(req);
  const wait = loginBlockedSec(ip);
  if (wait) {
    return res.redirect('/admin/login?locked=' + wait);
  }
  const user = String((req.body && req.body.username) || '');
  const pass = String((req.body && req.body.password) || '');
  if (user === ADMIN_USER && bcrypt.compareSync(pass, ADMIN_PASS_HASH)) {
    loginReset(ip);
    /* регенерируем сессию при входе — защита от session fixation */
    return req.session.regenerate(function (err) {
      if (err) return res.redirect('/admin/login?error=1');
      req.session.admin = true;
      res.redirect('/kitchen');
    });
  }
  loginFail(ip);
  res.redirect('/admin/login?error=1');
});

app.post('/admin/logout', requireAdmin, function (req, res) {
  req.session.destroy(function () { res.redirect('/admin/login'); });
});

/* Кухня — единая рабочая панель (кухня + вся админка через ☰).
   /admin оставлен как алиас на случай старых закладок — просто уводит сюда же. */
app.get('/admin', requireAdmin, function (req, res) {
  res.redirect('/kitchen');
});

app.get('/kitchen', requireAdmin, function (req, res) {
  res.sendFile(path.join(__dirname, 'kitchen.html'));
});

app.get('/api/orders', requireAdmin, function (req, res) {
  res.json({ ok: true, orders: store.list(), stats: store.stats(), insecure: USING_DEFAULT_PASS });
});

app.post('/api/orders/:id/status', requireAdmin, function (req, res) {
  const allowed = ['new', 'called', 'done', 'canceled'];
  const status = String((req.body && req.body.status) || '');
  if (allowed.indexOf(status) === -1) {
    return res.status(400).json({ ok: false, error: 'Недопустимый статус' });
  }
  const updated = store.updateStatus(req.params.id, status);
  if (!updated) return res.status(404).json({ ok: false, error: 'Заказ не найден' });
  notifyOrderChanged(updated);
  res.json({ ok: true, order: updated });
});

/* Заметка оператора к заказу. */
app.post('/api/orders/:id/note', requireAdmin, function (req, res) {
  const notes = String((req.body && req.body.notes) || '').slice(0, 2000);
  const updated = store.update(req.params.id, { notes: notes });
  if (!updated) return res.status(404).json({ ok: false, error: 'Заказ не найден' });
  notifyOrderChanged(updated);
  res.json({ ok: true, order: updated });
});

/* Статус доставки (видит клиент в трекинге). */
app.post('/api/orders/:id/track', requireAdmin, function (req, res) {
  const stage = String((req.body && req.body.track) || '');
  if (TRACK_STAGES.indexOf(stage) === -1) {
    return res.status(400).json({ ok: false, error: 'Недопустимый статус доставки' });
  }
  const patch = { track: stage };
  /* Синхронизируем внутренний статус (для статистики), чтобы оператору
     достаточно было вести только статус доставки. */
  if (stage === 'delivered') patch.status = 'done';
  else if (stage === 'canceled') patch.status = 'canceled';
  const updated = store.update(req.params.id, patch);
  if (!updated) return res.status(404).json({ ok: false, error: 'Заказ не найден' });
  notifyOrderChanged(updated);

  /* SMS-уведомление клиенту о смене статуса (если включено и настроен ключ).
     Тексты редактируются в настройках (Уведомления → SMS) — {id} подставляется номером заказа.
     Для стадий «delivering»/«delivered» при самовывозе берём отдельный *Pickup-текст. */
  try {
    const sset = settings.get();
    if (sset.smsEnabled === true && sms.isConfigured()) {
      const tpl = Object.assign({}, settings.DEFAULTS.smsTemplates, sset.smsTemplates || {});
      const isPickupOrder = updated.fulfillment === 'pickup';
      const key = (isPickupOrder && (stage === 'delivering' || stage === 'delivered')) ? stage + 'Pickup' : stage;
      const text = tpl[key] ? tpl[key].replace(/\{id\}/g, String(updated.id)) : '';
      if (text && updated.phone) {
        sms.send(updated.phone, (sset.brand || 'ЛавашОК') + ': ' + text)
          .catch(function () {});
      }
    }
  } catch (e) { console.error('sms:', e.message); }

  res.json({ ok: true, order: updated });
});

/* Редактирование заказа: данные клиента + состав (сумма пересчитывается по меню). */
app.post('/api/orders/:id/edit', requireAdmin, function (req, res) {
  const order = store.getById(req.params.id);
  if (!order) return res.status(404).json({ ok: false, error: 'Заказ не найден' });
  const b = req.body || {};

  const rawItems = Array.isArray(b.items) ? b.items : (order.items || []);
  const items = [];
  let total = 0;
  rawItems.forEach(function (it) {
    const m = menu.byId(it && it.id);
    if (!m) return;
    const qty = Math.min(Math.max(parseInt(it && it.qty, 10) || 0, 1), 99);
    items.push({ id: m.id, name: m.name, price: m.price, qty: qty, sum: m.price * qty });
    total += m.price * qty;
  });

  const patch = { items: items, total: total };
  if (typeof b.name === 'string') patch.name = b.name.trim().slice(0, 120);
  if (typeof b.phone === 'string') patch.phone = b.phone.trim().slice(0, 40);
  if (typeof b.comment === 'string') patch.comment = b.comment.trim().slice(0, 2000);

  const updated = store.update(order.id, patch);
  notifyOrderChanged(updated);
  res.json({ ok: true, order: updated });
});

/* Доставка Яндекс: создать заявку / обновить статус / вставить ссылку вручную. */
app.post('/api/orders/:id/yandex', requireAdmin, async function (req, res) {
  const order = store.getById(req.params.id);
  if (!order) return res.status(404).json({ ok: false, error: 'Заказ не найден' });
  const action = String((req.body && req.body.action) || '');

  if (action === 'link') {
    const url = String((req.body && req.body.url) || '').slice(0, 500);
    const updatedLink = store.update(order.id, { yandexTrackUrl: url });
    notifyOrderChanged(updatedLink);
    return res.json({ ok: true, order: updatedLink });
  }

  if (!yandex.isConfigured()) {
    return res.status(400).json({ ok: false, error: 'API Яндекс.Доставки не настроен (нет YANDEX_DELIVERY_TOKEN)' });
  }

  try {
    if (action === 'create') {
      const claim = await yandex.createClaim(order);
      const updated = store.update(order.id, {
        yandexClaimId: claim.id || '',
        yandexStatus: claim.status || 'new',
        yandexTrackUrl: yandex.extractTrackUrl(claim),
        track: yandex.mapStatus(claim.status)
      });
      notifyOrderChanged(updated);
      return res.json({ ok: true, order: updated });
    }
    if (action === 'refresh') {
      if (!order.yandexClaimId) return res.status(400).json({ ok: false, error: 'У заказа нет заявки Яндекс' });
      const info = await yandex.getInfo(order.yandexClaimId);
      const updated = store.update(order.id, {
        yandexStatus: info.status || order.yandexStatus,
        yandexTrackUrl: yandex.extractTrackUrl(info) || order.yandexTrackUrl || '',
        track: yandex.mapStatus(info.status)
      });
      notifyOrderChanged(updated);
      return res.json({ ok: true, order: updated });
    }
    return res.status(400).json({ ok: false, error: 'Неизвестное действие' });
  } catch (e) {
    console.error('Yandex delivery:', e.message);
    return res.status(502).json({ ok: false, error: e.message || 'Ошибка Яндекс.Доставки' });
  }
});

/* Возврат оплаты по успешному онлайн-заказу (полностью). */
app.post('/api/orders/:id/refund', requireAdmin, async function (req, res) {
  const order = store.getById(req.params.id);
  if (!order) return res.status(404).json({ ok: false, error: 'Заказ не найден' });
  if (order.payment !== 'online' || order.paymentStatus !== 'succeeded') {
    return res.status(400).json({ ok: false, error: 'Возврат доступен только для успешно оплаченных онлайн-заказов' });
  }
  if (!order.paymentId) return res.status(400).json({ ok: false, error: 'У заказа нет ID платежа' });
  if (!yookassa.isConfigured()) return res.status(400).json({ ok: false, error: 'Онлайн-оплата не настроена' });
  try {
    await yookassa.refund(order.paymentId, Number(order.total || 0).toFixed(2));
    const updated = store.update(order.id, { paymentStatus: 'refunded' });
    notifyOrderChanged(updated);
    res.json({ ok: true, order: updated });
  } catch (e) {
    console.error('YooKassa refund:', e.message);
    res.status(502).json({ ok: false, error: e.message || 'Не удалось выполнить возврат' });
  }
});

/* Создание заказа оператором вручную (приём по телефону). Цены — с сервера. */
app.post('/api/admin/orders/create', requireAdmin, function (req, res) {
  const b = req.body || {};
  const phone = String(b.phone || '').trim();
  if (phone.replace(/\D/g, '').length < 5) {
    return res.status(400).json({ ok: false, error: 'Укажите телефон клиента' });
  }
  const items = [];
  let total = 0;
  (Array.isArray(b.items) ? b.items : []).forEach(function (it) {
    const m = menu.byId(it && it.id);
    if (!m) return;
    const qty = Math.min(Math.max(parseInt(it && it.qty, 10) || 0, 1), 99);
    items.push({ id: m.id, name: m.name, price: m.price, qty: qty, sum: m.price * qty });
    total += m.price * qty;
  });
  if (!items.length) {
    return res.status(400).json({ ok: false, error: 'Добавьте хотя бы одно блюдо' });
  }
  const payment = b.payment === 'online' ? 'online' : 'cash';
  const fulfillment = b.fulfillment === 'pickup' ? 'pickup' : 'delivery';
  const trackToken = crypto.randomBytes(8).toString('hex');
  const order = store.add({
    name: String(b.name || '').trim().slice(0, 120),
    phone: phone.slice(0, 40),
    comment: String(b.comment || '').trim().slice(0, 2000),
    items: items,
    total: total,
    subtotal: total,
    discount: 0,
    promoCode: '',
    payment: payment,
    fulfillment: fulfillment,
    paymentStatus: payment === 'online' ? 'pending' : 'not_required',
    track: 'accepted',
    trackToken: trackToken,
    utm: { source: 'admin' },
    pageUrl: '',
    ip: '',
    userAgent: 'admin-manual'
  });
  console.log('📝  Заказ оформлен оператором #' + order.id + ': ' + (order.name || '—') + ' / ' + order.phone + ' · ' + total + ' ₽');
  notifyOrderChanged(order);
  try {
    const sset = settings.get();
    if (sset.loyaltyEnabled === true) {
      const rec = loyalty.getRecord(order.phone);
      const tier = loyalty.tierFor(rec.lifetimeSpend, sset.loyaltyTiers) || { percent: Number(sset.loyaltyPercent) || 0 };
      const pts = Math.round(total * (Number(tier.percent) || 0) / 100);
      loyalty.add(order.phone, pts, total);
      loyalty.ensureCard(order.phone);
      if (pts > 0) store.update(order.id, { pointsEarned: pts }); // для истории в личном кабинете
    }
  } catch (e) { console.error('loyalty:', e.message); }
  res.json({ ok: true, order: order, orderNo: fmtOrderNo(order) });
});

/* Загрузка фото блюда из админки. */
app.post('/api/admin/upload', requireAdmin, function (req, res) {
  upload.single('photo')(req, res, function (err) {
    if (err) return res.status(400).json({ ok: false, error: 'Не удалось загрузить файл (макс. 4 МБ, только изображения)' });
    if (!req.file) return res.status(400).json({ ok: false, error: 'Файл не получен' });
    res.json({ ok: true, url: '/uploads/' + req.file.filename });
  });
});

/* ── Меню: чтение и сохранение из админки ────────────────── */
const menuItemSchema = z.object({
  id: z.string().max(60).optional(),
  name: z.string().min(1).max(120),
  price: z.coerce.number().min(0).max(100000),
  category: z.string().max(40).optional().default('other'),
  emoji: z.string().max(12).optional().default('🌯'),
  weight: z.string().max(40).optional().default(''),
  spicy: z.string().max(40).optional().default(''),
  hit: z.string().max(40).optional().default(''),
  desc: z.string().max(500).optional().default(''),
  image: z.string().max(300).optional().default(''),
  available: z.boolean().optional().default(true)
}).strip();

app.get('/api/admin/menu', requireAdmin, function (req, res) {
  res.json({ ok: true, items: menu.all(), categories: menu.CATEGORIES });
});

app.put('/api/admin/menu', requireAdmin, function (req, res) {
  const parsed = z.object({ items: z.array(menuItemSchema).max(100) }).safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'Некорректные данные меню' });
  const seen = {};
  const items = parsed.data.items.map(function (it) {
    let id = (it.id && it.id.trim()) ? it.id.trim()
      : ('item-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    while (seen[id]) id = id + Math.random().toString(36).slice(2, 4);
    seen[id] = true;
    return {
      id: id,
      name: it.name.trim(),
      price: Math.round(it.price),
      category: (it.category || 'other').trim(),
      emoji: it.emoji || '🌯',
      weight: it.weight || '',
      spicy: it.spicy || '',
      hit: it.hit || '',
      desc: it.desc || '',
      image: it.image || '',
      available: it.available !== false
    };
  });
  res.json({ ok: true, items: menu.saveAll(items) });
});

/* Стоп-лист: быстро включить/выключить доступность блюда (с кухни). */
app.post('/api/admin/menu/:id/available', requireAdmin, function (req, res) {
  const items = menu.all();
  const it = items.find(function (x) { return x.id === req.params.id; });
  if (!it) return res.status(404).json({ ok: false, error: 'Блюдо не найдено' });
  it.available = !!(req.body && req.body.available);
  menu.saveAll(items);
  res.json({ ok: true, item: it });
});

/* ── Настройки заведения ─────────────────────────────────── */
const zoneSchema = z.object({
  name: z.string().max(80),
  price: z.coerce.number().min(0).max(100000),
  minOrder: z.coerce.number().min(0).max(1000000).optional().default(0),
  time: z.string().max(60).optional().default('')
}).strip();

const settingsSchema = z.object({
  brand: z.string().max(60).optional(),
  phone: z.string().max(40).optional(),
  address: z.string().max(200).optional(),
  hours: z.string().max(120).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  yandexStaticApiKey: z.string().max(80).optional(),
  whatsapp: z.string().max(40).optional(),
  telegram: z.string().max(60).optional(),
  freeDeliveryFrom: z.coerce.number().min(0).max(100000).optional(),
  minOrder: z.coerce.number().min(0).max(100000).optional(),
  promoBanner: z.string().max(200).optional(),
  ordersOpen: z.boolean().optional(),                              // П.9
  ordersClosedMsg: z.string().max(200).optional(),                // П.9
  scheduleEnabled: z.boolean().optional(),                         // расписание работы
  scheduleOpen: z.string().max(5).optional(),
  scheduleClose: z.string().max(5).optional(),
  deliveryZones: z.array(zoneSchema).max(50).optional(),          // П.5
  city: z.string().max(80).optional(),                            // П.7
  seoTitle: z.string().max(160).optional(),                       // П.7
  seoDescription: z.string().max(320).optional(),                 // П.7
  seoKeywords: z.string().max(500).optional(),                    // П.7
  yandexMetrikaId: z.string().max(20).optional(),                 // счётчик Метрики (только цифры)
  loyaltyEnabled: z.boolean().optional(),                         // лояльность
  loyaltyPercent: z.coerce.number().min(0).max(50).optional(),    // лояльность
  smsEnabled: z.boolean().optional(),                             // SMS
  smsTemplates: z.object({
    cooking: z.string().max(300).optional(),
    delivering: z.string().max(300).optional(),
    deliveringPickup: z.string().max(300).optional(),
    delivered: z.string().max(300).optional(),
    deliveredPickup: z.string().max(300).optional(),
    canceled: z.string().max(300).optional()
  }).optional(),
  kitchenTargetMin: z.coerce.number().min(1).max(180).optional(),  // целевое время готовки для кухни
  preorderEnabled: z.boolean().optional(),                         // предзаказ на самовывоз
  preorderLeadMin: z.coerce.number().min(10).max(240).optional(),
  preorderMaxDays: z.coerce.number().min(1).max(7).optional()
}).strip();

app.get('/api/admin/settings', requireAdmin, function (req, res) {
  res.json({ ok: true, settings: settings.get() });
});

/* Резервная копия настроек/меню/акций/карт лояльности — одним JSON-файлом.
   Пароли (личные кабинеты, админ) сюда сознательно не попадают. */
app.get('/api/admin/backup.json', requireAdmin, function (req, res) {
  const backup = {
    exportedAt: new Date().toISOString(),
    brand: settings.get().brand || 'ЛавашОК',
    settings: settings.get(),
    menu: menu.all(),
    promos: promo.all(),
    loyaltyCards: loyalty.listAll()
  };
  res.set({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': 'attachment; filename="lavashok-backup-' + localDateKey(new Date()) + '.json"'
  });
  res.send(JSON.stringify(backup, null, 2));
});
app.put('/api/admin/settings', requireAdmin, function (req, res) {
  const parsed = settingsSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'Некорректные настройки' });
  res.json({ ok: true, settings: settings.save(parsed.data) });
});

/* ── Промокоды (акции) ───────────────────────────────────── */
const promoSchema = z.object({
  code: z.string().min(1).max(40),
  type: z.enum(['percent', 'fixed']).optional().default('percent'),
  value: z.coerce.number().min(0).max(100000),
  minOrder: z.coerce.number().min(0).max(1000000).optional().default(0),
  maxUses: z.coerce.number().min(0).max(1000000).optional().default(0),
  uses: z.coerce.number().min(0).optional().default(0),
  expires: z.string().max(20).optional().default(''),
  active: z.boolean().optional().default(true),
  label: z.string().max(120).optional().default('')
}).strip();

app.get('/api/admin/promos', requireAdmin, function (req, res) {
  res.json({ ok: true, promos: promo.all() });
});
app.put('/api/admin/promos', requireAdmin, function (req, res) {
  const parsed = z.object({ promos: z.array(promoSchema).max(200) }).safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'Некорректные промокоды' });
  const items = parsed.data.promos.map(function (p) {
    return {
      code: String(p.code).trim().toUpperCase(),
      type: p.type, value: Math.round(p.value),
      minOrder: Math.round(p.minOrder), maxUses: Math.round(p.maxUses), uses: Math.round(p.uses),
      expires: p.expires || '', active: p.active !== false, label: p.label || ''
    };
  });
  res.json({ ok: true, promos: promo.saveAll(items) });
});

/* ── Клиенты (CRM): агрегация заказов по телефону — шире, чем «Карты»
   (там только держатели карт лояльности, здесь вообще все, кто заказывал). ── */
app.get('/api/admin/customers', requireAdmin, function (req, res) {
  const s = settings.get();
  const byPhone = {}; // digits -> { phone, name, orders: [] }
  store.list().forEach(function (o) {
    const digits = String(o.phone || '').replace(/\D/g, '');
    if (digits.length < 5) return;
    if (!byPhone[digits]) byPhone[digits] = { phone: o.phone, name: '', orders: [] };
    const rec = byPhone[digits];
    rec.orders.push(o);
    if (!rec._lastAt || new Date(o.createdAt) > new Date(rec._lastAt)) {
      rec._lastAt = o.createdAt;
      rec.name = o.name || rec.name;
      rec.phone = o.phone || rec.phone;
    }
  });

  const list = Object.keys(byPhone).map(function (digits) {
    const rec = byPhone[digits];
    const nonCanceled = rec.orders.filter(function (o) { return o.status !== 'canceled'; });
    const totalSpend = nonCanceled.reduce(function (s2, o) { return s2 + (Number(o.total) || 0); }, 0);
    const lastOrder = rec.orders.reduce(function (a, b) { return new Date(a.createdAt) > new Date(b.createdAt) ? a : b; });
    const loy = loyalty.getRecord(digits);
    const tier = loyalty.tierFor(loy.lifetimeSpend, s.loyaltyTiers);
    return {
      phone: rec.phone,
      name: rec.name,
      ordersCount: rec.orders.length,
      totalSpend: totalSpend,
      lastOrderAt: lastOrder ? lastOrder.createdAt : null,
      cardNo: loy.cardNo || '',
      points: loy.balance,
      tierName: tier ? tier.name : '',
      hasAccount: customers.exists(digits)
    };
  }).sort(function (a, b) { return new Date(b.lastOrderAt) - new Date(a.lastOrderAt); });

  res.json({ ok: true, customers: list });
});

/* Экспорт базы клиентов (CRM) в Excel — та же агрегация, что и /api/admin/customers. */
app.get('/api/admin/customers.xlsx', requireAdmin, function (req, res) {
  const s = settings.get();
  const byPhone = {};
  store.list().forEach(function (o) {
    const digits = String(o.phone || '').replace(/\D/g, '');
    if (digits.length < 5) return;
    if (!byPhone[digits]) byPhone[digits] = { phone: o.phone, name: '', orders: [] };
    const rec = byPhone[digits];
    rec.orders.push(o);
    if (!rec._lastAt || new Date(o.createdAt) > new Date(rec._lastAt)) {
      rec._lastAt = o.createdAt;
      rec.name = o.name || rec.name;
      rec.phone = o.phone || rec.phone;
    }
  });

  const list = Object.keys(byPhone).map(function (digits) {
    const rec = byPhone[digits];
    const nonCanceled = rec.orders.filter(function (o) { return o.status !== 'canceled'; });
    const totalSpend = nonCanceled.reduce(function (s2, o) { return s2 + (Number(o.total) || 0); }, 0);
    const lastOrder = rec.orders.reduce(function (a, b) { return new Date(a.createdAt) > new Date(b.createdAt) ? a : b; });
    const loy = loyalty.getRecord(digits);
    const tier = loyalty.tierFor(loy.lifetimeSpend, s.loyaltyTiers);
    return {
      phone: rec.phone,
      name: rec.name,
      ordersCount: rec.orders.length,
      totalSpend: totalSpend,
      lastOrderAt: lastOrder ? lastOrder.createdAt : null,
      cardNo: loy.cardNo || '',
      points: loy.balance,
      tierName: tier ? tier.name : '',
      hasAccount: customers.exists(digits)
    };
  }).sort(function (a, b) { return new Date(b.lastOrderAt) - new Date(a.lastOrderAt); });

  const pad2 = function (n) { return (n < 10 ? '0' : '') + n; };
  const fmtDateForExport = function (iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  };
  const header = ['Телефон', 'Имя', 'Заказов', 'Сумма покупок, ₽', 'Последний заказ', 'Карта №', 'Баллы', 'Уровень', 'Есть кабинет'];
  const rows = list.map(function (c) {
    return [
      c.phone || '', c.name || '', c.ordersCount, c.totalSpend,
      c.lastOrderAt ? fmtDateForExport(c.lastOrderAt) : '',
      c.cardNo || '', c.points || 0, c.tierName || '', c.hasAccount ? 'Да' : 'Нет'
    ];
  });
  const sheet = XLSX.utils.aoa_to_sheet([header].concat(rows));
  sheet['!cols'] = [
    { wch: 16 }, { wch: 20 }, { wch: 9 }, { wch: 16 }, { wch: 18 }, { wch: 10 }, { wch: 9 }, { wch: 16 }, { wch: 12 }
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'Клиенты');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': 'attachment; filename="lavashok-customers-' + localDateKey(new Date()) + '.xlsx"'
  });
  res.send(buf);
});

/* ── Карты лояльности (админка): список, поиск, ручная корректировка баллов ── */
app.get('/api/admin/loyalty-cards', requireAdmin, function (req, res) {
  const s = settings.get();
  const cards = loyalty.listAll().map(function (c) {
    const tier = loyalty.tierFor(c.lifetimeSpend, s.loyaltyTiers);
    const prefs = customers.getPrefs(c.phone);
    return {
      phone: c.phone,
      cardNo: c.cardNo,
      balance: c.balance,
      lifetimeSpend: c.lifetimeSpend,
      tierName: tier ? tier.name : '',
      hasAccount: customers.exists(c.phone), // есть ли у клиента личный кабинет (пароль)
      autoTopup: Object.assign({ enabled: false, amount: 500, threshold: 100 }, prefs.autoTopup || {})
    };
  }).sort(function (a, b) { return b.lifetimeSpend - a.lifetimeSpend; });
  res.json({ ok: true, cards: cards });
});

/* Автопополнение карты — настраивается оператором из админки («Карты»).
   ⚠ Сохраняется только настройка. Реального списания денег нет: для него нужен
   бэкенд-биллинг (сохранённый способ оплаты ЮKassa с рекуррентными платежами) —
   при подключении используйте эти сохранённые поля. */
const autoTopupSchema = z.object({
  enabled: z.boolean().optional().default(false),
  amount: z.coerce.number().min(50).max(100000).optional().default(500),
  threshold: z.coerce.number().min(0).max(100000).optional().default(100)
}).strip();

app.post('/api/admin/loyalty-cards/:phone/autotopup', requireAdmin, function (req, res) {
  const phone = String(req.params.phone || '').replace(/\D/g, '');
  if (phone.length < 5) return res.status(400).json({ ok: false, error: 'Некорректный телефон' });
  const parsed = autoTopupSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'Некорректные настройки автопополнения' });
  customers.setPrefs(phone, { autoTopup: parsed.data });
  res.json({ ok: true, autoTopup: parsed.data });
});

const loyaltyAdjustSchema = z.object({
  points: z.coerce.number().int().min(-1000000).max(1000000)
});
app.post('/api/admin/loyalty-cards/:phone/adjust', requireAdmin, function (req, res) {
  const parsed = loyaltyAdjustSchema.safeParse(req.body || {});
  if (!parsed.success || parsed.data.points === 0) {
    return res.status(400).json({ ok: false, error: 'Укажите количество баллов (положительное или отрицательное, не 0)' });
  }
  const phone = String(req.params.phone || '');
  const balance = loyalty.adjustBalance(phone, parsed.data.points);
  res.json({ ok: true, balance: balance });
});

/* Выдать карту вручную (например, клиент позвонил, но ещё не оформлял заказ на сайте). */
app.post('/api/admin/loyalty-cards/:phone/issue', requireAdmin, function (req, res) {
  const phone = String(req.params.phone || '').replace(/\D/g, '');
  if (phone.length < 5) return res.status(400).json({ ok: false, error: 'Укажите телефон клиента' });
  const rec = loyalty.ensureCard(phone);
  res.json({ ok: true, cardNo: rec.cardNo, balance: rec.balance });
});

/* Завести/сбросить личный кабинет клиенту из админки — генерируем временный пароль
   и показываем его один раз, чтобы оператор продиктовал клиенту по телефону.
   Заодно выдаём карту, если её ещё не было. */
app.post('/api/admin/customers/:phone/set-password', requireAdmin, function (req, res) {
  const phone = String(req.params.phone || '').replace(/\D/g, '');
  if (phone.length < 5) return res.status(400).json({ ok: false, error: 'Укажите телефон клиента' });
  const tempPassword = crypto.randomBytes(3).toString('hex'); // 6 символов, легко продиктовать
  const ok = customers.setPassword(phone, tempPassword);
  if (!ok) return res.status(400).json({ ok: false, error: 'Не удалось задать пароль' });
  const cardNo = loyalty.ensureCard(phone).cardNo;
  res.json({ ok: true, password: tempPassword, cardNo: cardNo });
});

/* Итоги дня для кухни/админки — выгрузка в Excel (.xlsx), два листа: «Итоги» и «Заказы».
   ?date=YYYY-MM-DD — по умолчанию сегодняшний день сервера. */
app.get('/api/admin/reports/daily.xlsx', requireAdmin, function (req, res) {
  const dateParam = String(req.query.date || '').trim();
  const targetKey = /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : localDateKey(new Date());

  const dayOrders = store.list().filter(function (o) {
    return o.createdAt && localDateKey(new Date(o.createdAt)) === targetKey;
  });
  const active = dayOrders.filter(function (o) { return o.status !== 'canceled'; });
  const revenue = active.reduce(function (s, o) { return s + (Number(o.total) || 0); }, 0);
  const avgCheck = active.length ? Math.round(revenue / active.length) : 0;
  const delivered = dayOrders.filter(function (o) { return (o.track || '') === 'delivered'; });
  const avgPrepMin = delivered.length
    ? Math.round(delivered.reduce(function (s, o) {
        const start = new Date(o.createdAt).getTime();
        const end = new Date(o.updatedAt || o.createdAt).getTime();
        return s + Math.max(0, (end - start) / 60000);
      }, 0) / delivered.length)
    : 0;
  const pickupCnt = active.filter(function (o) { return o.fulfillment === 'pickup'; }).length;
  const deliveryCnt = active.length - pickupCnt;
  const cashCnt = active.filter(function (o) { return o.payment !== 'online'; }).length;
  const onlineCnt = active.length - cashCnt;
  const canceledCnt = dayOrders.length - active.length;

  const summaryRows = [
    ['Итоги дня — ' + (settings.get().brand || 'ЛавашОК'), targetKey],
    [],
    ['Всего заказов', active.length],
    ['Выручка, ₽', revenue],
    ['Средний чек, ₽', avgCheck],
    ['Среднее время до доставки/выдачи, мин', avgPrepMin],
    ['Доставка', deliveryCnt],
    ['Самовывоз', pickupCnt],
    ['Наличными/картой курьеру', cashCnt],
    ['Онлайн-оплата', onlineCnt],
    ['Отменено', canceledCnt]
  ];
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  summarySheet['!cols'] = [{ wch: 42 }, { wch: 16 }];

  const statusMap = { new: 'Новый', called: 'Обзвонен', done: 'Готов', canceled: 'Отменён' };
  const detailHeader = ['№', 'Время', 'Имя', 'Телефон', 'Состав', 'Сумма, ₽', 'Оплата', 'Получение', 'Статус'];
  const detailRows = dayOrders.map(function (o) {
    const d = new Date(o.createdAt);
    const p = function (n) { return (n < 10 ? '0' : '') + n; };
    const timeStr = p(d.getHours()) + ':' + p(d.getMinutes());
    const itemsStr = (o.items || []).map(function (it) { return it.name + ' ×' + it.qty; }).join(', ');
    return [
      fmtOrderNo(o), timeStr, o.name || '', o.phone || '', itemsStr, Number(o.total) || 0,
      o.payment === 'online' ? 'Онлайн' : 'При получении',
      o.fulfillment === 'pickup' ? 'Самовывоз' : 'Доставка',
      statusMap[o.status] || o.status || ''
    ];
  });
  const detailSheet = XLSX.utils.aoa_to_sheet([detailHeader].concat(detailRows));
  detailSheet['!cols'] = [
    { wch: 10 }, { wch: 8 }, { wch: 16 }, { wch: 16 }, { wch: 44 }, { wch: 10 }, { wch: 14 }, { wch: 12 }, { wch: 10 }
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, summarySheet, 'Итоги');
  XLSX.utils.book_append_sheet(wb, detailSheet, 'Заказы');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': 'attachment; filename="lavashok-' + targetKey + '.xlsx"'
  });
  res.send(buf);
});

app.get('/health', function (req, res) {
  res.json({ ok: true, uptime: process.uptime(), store: store.driver });
});

app.use(function (req, res) {
  res.status(404).send('Не найдено');
});

const server = app.listen(PORT, function () {
  console.log('');
  console.log('  🌯  ЛавашОК запущен!');
  console.log('  ─────────────────────────────────────────────');
  console.log('  Сайт:    http://localhost:' + PORT);
  console.log('  Админка: http://localhost:' + PORT + '/admin');
  console.log('  Вход:    ' + ADMIN_USER + (process.env.ADMIN_PASS_HASH ? '  (пароль из ADMIN_PASS_HASH)' : '  / пароль: ' + (process.env.ADMIN_PASS || 'lavashok')));
  console.log('  Хранилище: ' + store.driver.toUpperCase());
  console.log('  Онлайн-оплата ЮKassa: ' + (yookassa.isConfigured() ? 'включена' : 'выключена (нет ключей)'));
  if (!process.env.SESSION_SECRET) {
    console.log('  ⚠  SESSION_SECRET не задан — используется сохранённый в data/.session-secret ' +
      '(для нескольких серверов/инстансов задайте один SESSION_SECRET через env).');
  }
  if (USING_DEFAULT_PASS) {
    console.log('  ⚠  Используется ПАРОЛЬ ПО УМОЛЧАНИЮ (lavashok). Смените: npm run hash "новый-пароль" → ADMIN_PASS_HASH.');
  }
  console.log('  ─────────────────────────────────────────────');
  console.log('');
});

/* Понятное сообщение, если порт занят (сервер уже запущен в другом окне). */
server.on('error', function (err) {
  if (err && err.code === 'EADDRINUSE') {
    console.error('');
    console.error('  ⚠  Порт ' + PORT + ' уже занят — скорее всего, ЛавашОК уже запущен в другом окне.');
    console.error('     Закройте то окно, либо запустите на другом порту:');
    console.error('     PowerShell:  $env:PORT="3001"; npm start   →  http://localhost:3001');
    console.error('     Освободить порт 3000:  Get-Process -Id (Get-NetTCPConnection -LocalPort 3000).OwningProcess | Stop-Process -Force');
    console.error('');
    process.exit(1);
  }
  throw err;
});
