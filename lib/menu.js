/* ============================================================
   Меню ЛавашОК — источник правды по блюдам и ценам.
   Хранится в data/menu.json (создаётся из SEED при первом запуске),
   редактируется из админки. Сервер считает суммы заказов по этим ценам.
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = require('./paths').DATA_DIR;
const FILE = path.join(DATA_DIR, 'menu.json');

const SEED = [
  { id: 'shawarma-classic', name: 'Шаурма Классическая', price: 199, category: 'shawarma', emoji: '🌯', image: '/img/dishes/shawarma-classic.svg', weight: '350 г', spicy: '🌶 Средняя', hit: '', desc: 'Куриное филе, свежая капуста, помидор, огурец, сыр, фирменный соус в тонком лаваше', available: true },
  { id: 'shawarma-double',  name: 'Шаурма Двойная',      price: 299, category: 'shawarma', emoji: '🌮', image: '/img/dishes/shawarma-double.svg', weight: '550 г', spicy: '🔥 Острая',  hit: '⭐ Хит', desc: 'Двойная порция куриного филе, два соуса — для настоящих героев аппетита', available: true },
  { id: 'lavash-cheese',    name: 'Лаваш с сыром',        price: 89,  category: 'lavash',   emoji: '🫓', image: '/img/dishes/lavash-cheese.svg', weight: '200 г', spicy: '',           hit: '', desc: 'Хрустящий лаваш, плавленый сыр, свежая зелень — простое блаженство', available: true },
  { id: 'lavash-meat',      name: 'Лаваш с мясом',        price: 159, category: 'lavash',   emoji: '🥙', image: '/img/dishes/lavash-meat.svg', weight: '300 г', spicy: '🌶 Средняя', hit: '', desc: 'Сочное куриное или говяжье мясо, запечённые овощи, чесночный соус', available: true },
  { id: 'combo',            name: 'Комбо «ЛавашОК»',      price: 329, category: 'combo',    emoji: '🎁', image: '/img/dishes/combo.svg', weight: '',      spicy: '',           hit: '⭐ Выгодно', desc: 'Шаурма классическая + лаваш с сыром + напиток на выбор. Экономия 50 ₽!', available: true },
  { id: 'drinks',           name: 'Напитки',              price: 59,  category: 'drinks',   emoji: '🥤', image: '/img/dishes/drinks.svg', weight: '0,5 л', spicy: '',           hit: '', desc: 'Кола, Спрайт, Фанта, Вода — холодненькие, как надо', available: true },
  { id: 'addon-sauce',      name: 'Доп. соус',            price: 30,  category: 'addon',    emoji: '🥫', image: '/img/dishes/addon-sauce.svg', weight: '30 г',  spicy: '',           hit: '', desc: 'Фирменный, чесночный или острый — на выбор', available: true },
  { id: 'addon-cheese',     name: 'Доп. сыр',             price: 40,  category: 'addon',    emoji: '🧀', image: '/img/dishes/addon-cheese.svg', weight: '30 г',  spicy: '',           hit: '', desc: 'Ещё больше сыра в вашей шаурме или лаваше', available: true },
  { id: 'addon-meat',       name: 'Доп. мясо',            price: 70,  category: 'addon',    emoji: '🍗', image: '/img/dishes/addon-meat.svg', weight: '80 г',  spicy: '',           hit: '', desc: 'Двойная порция куриного филе', available: true },
  { id: 'addon-veggies',    name: 'Доп. овощи',           price: 30,  category: 'addon',    emoji: '🥬', image: '/img/dishes/addon-veggies.svg', weight: '50 г',  spicy: '',           hit: '', desc: 'Свежая капуста, помидор, огурец — побольше хрусткости', available: true }
];

const CATEGORIES = [
  { id: 'shawarma', label: 'Шаурма' },
  { id: 'lavash',   label: 'Лаваши' },
  { id: 'combo',    label: 'Комбо' },
  { id: 'drinks',   label: 'Напитки' },
  { id: 'addon',    label: 'Добавки' }
];

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, JSON.stringify(SEED, null, 2), 'utf8');
}

function all() {
  ensure();
  try {
    const raw = fs.readFileSync(FILE, 'utf8').trim();
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) && arr.length ? arr : SEED.slice();
  } catch (e) {
    console.error('menu: не удалось прочитать menu.json —', e.message);
    return SEED.slice();
  }
}

/* Только доступные блюда — для витрины сайта. */
function publicList() {
  return all().filter(function (i) { return i.available !== false; });
}

function byId(id) {
  return all().find(function (i) { return i.id === id; }) || null;
}

function saveAll(items) {
  ensure();
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
  return all();
}

module.exports = { all, publicList, byId, saveAll, SEED, CATEGORIES };
