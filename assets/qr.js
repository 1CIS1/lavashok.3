/* ============================================================
   Мини-генератор QR-кодов (без внешних зависимостей).
   Причина самописной реализации: CSP сайта разрешает скрипты
   только с собственного домена, CDN-библиотеки заблокированы.
   Поддержка: byte mode, версии 1–4, коррекция M — до 62 байт
   данных (ID карты лояльности умещается с большим запасом).
   API:  QRMini.svg('482915', { size: 160 }) → строка <svg>.
   ============================================================ */
'use strict';
var QRMini = (function () {

  /* ── Галуа-поле GF(256), полином 0x11d ── */
  var EXP = new Array(512), LOG = new Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();
  function gmul(a, b) { if (!a || !b) return 0; return EXP[LOG[a] + LOG[b]]; }

  /* Порождающий полином Рида-Соломона степени n. */
  function rsGenPoly(n) {
    var poly = [1];
    for (var i = 0; i < n; i++) {
      var next = new Array(poly.length + 1);
      for (var k = 0; k < next.length; k++) next[k] = 0;
      for (var j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];                    // умножение на x
        next[j + 1] ^= gmul(poly[j], EXP[i]);  // умножение на α^i
      }
      poly = next;
    }
    return poly; // старшая степень первой
  }

  /* Остаток от деления сообщения на порождающий полином — байты коррекции. */
  function rsEncode(data, ecCount) {
    var gen = rsGenPoly(ecCount);
    var buf = data.concat(new Array(ecCount).fill(0));
    for (var i = 0; i < data.length; i++) {
      var factor = buf[i];
      if (!factor) continue;
      for (var j = 1; j < gen.length; j++) buf[i + j] ^= gmul(gen[j], factor);
    }
    return buf.slice(data.length);
  }

  /* ── Таблицы для версий 1–4, уровень коррекции M ──
     [числоБлоков, всегоКодовыхСлов в блоке, из них данных] */
  var BLOCKS = {
    1: [[1, 26, 16]],
    2: [[1, 44, 28]],
    3: [[1, 70, 44]],
    4: [[2, 50, 32]]
  };
  var ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26] };

  function dataCapacity(v) {
    return BLOCKS[v].reduce(function (s, b) { return s + b[0] * b[2]; }, 0);
  }

  /* Формат-информация: уровень M (биты 00) + маска, код БЧХ(15,5). */
  function bchDigit(d) { var n = 0; while (d) { n++; d >>>= 1; } return n; }
  function formatBits(mask) {
    var G15 = 0x537, MASKF = 0x5412;
    var data = mask; // (00 << 3) | mask — уровень M
    var d = data << 10;
    while (bchDigit(d) - bchDigit(G15) >= 0) d ^= G15 << (bchDigit(d) - bchDigit(G15));
    return ((data << 10) | d) ^ MASKF;
  }

  function toUtf8(str) {
    var out = [], s = unescape(encodeURIComponent(String(str)));
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return out;
  }

  function build(text) {
    var bytes = toUtf8(text);

    /* выбор минимальной версии */
    var version = 0;
    for (var v = 1; v <= 4; v++) {
      if (4 + 8 + bytes.length * 8 <= dataCapacity(v) * 8 - 0) { version = v; break; }
    }
    if (!version) throw new Error('QRMini: данные длиннее 62 байт');

    /* ── битовый поток: режим 0100, длина (8 бит), данные, терминатор, паддинг ── */
    var bits = [], pushBits = function (val, len) {
      for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
    };
    pushBits(4, 4);                 // byte mode
    pushBits(bytes.length, 8);      // счётчик (8 бит для версий 1–9)
    bytes.forEach(function (b) { pushBits(b, 8); });
    var capBits = dataCapacity(version) * 8;
    pushBits(0, Math.min(4, capBits - bits.length));            // терминатор
    while (bits.length % 8) bits.push(0);
    var dataCw = [];
    for (var i = 0; i < bits.length; i += 8) {
      var b8 = 0;
      for (var k = 0; k < 8; k++) b8 = (b8 << 1) | bits[i + k];
      dataCw.push(b8);
    }
    var padSeq = [0xEC, 0x11], p = 0;
    while (dataCw.length < dataCapacity(version)) dataCw.push(padSeq[(p++) % 2]);

    /* ── разбивка на блоки + коды коррекции + перемежение ── */
    var blocks = [], offset = 0;
    BLOCKS[version].forEach(function (spec) {
      for (var b = 0; b < spec[0]; b++) {
        var dc = dataCw.slice(offset, offset + spec[2]);
        offset += spec[2];
        blocks.push({ data: dc, ec: rsEncode(dc, spec[1] - spec[2]) });
      }
    });
    var interleaved = [];
    var maxDc = Math.max.apply(null, blocks.map(function (b) { return b.data.length; }));
    var maxEc = Math.max.apply(null, blocks.map(function (b) { return b.ec.length; }));
    for (var di = 0; di < maxDc; di++) blocks.forEach(function (b) { if (di < b.data.length) interleaved.push(b.data[di]); });
    for (var ei = 0; ei < maxEc; ei++) blocks.forEach(function (b) { if (ei < b.ec.length) interleaved.push(b.ec[ei]); });

    /* ── матрица ── */
    var size = 17 + version * 4;
    var m = [], reserved = [];
    for (var r = 0; r < size; r++) { m.push(new Array(size).fill(false)); reserved.push(new Array(size).fill(false)); }
    function set(r2, c2, val) { m[r2][c2] = !!val; reserved[r2][c2] = true; }

    /* поисковые узоры (3 угла) + разделители */
    function finder(r0, c0) {
      for (var r2 = -1; r2 <= 7; r2++) for (var c2 = -1; c2 <= 7; c2++) {
        var rr = r0 + r2, cc = c0 + c2;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        var dark = (r2 >= 0 && r2 <= 6 && (c2 === 0 || c2 === 6)) ||
                   (c2 >= 0 && c2 <= 6 && (r2 === 0 || r2 === 6)) ||
                   (r2 >= 2 && r2 <= 4 && c2 >= 2 && c2 <= 4);
        set(rr, cc, dark);
      }
    }
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

    /* выравнивающие узоры */
    var ap = ALIGN[version];
    for (var ai = 0; ai < ap.length; ai++) for (var aj = 0; aj < ap.length; aj++) {
      var ar = ap[ai], ac = ap[aj];
      if (reserved[ar][ac]) continue; // пересечение с поисковым
      for (var r3 = -2; r3 <= 2; r3++) for (var c3 = -2; c3 <= 2; c3++) {
        set(ar + r3, ac + c3, Math.max(Math.abs(r3), Math.abs(c3)) !== 1);
      }
    }

    /* синхронизация */
    for (var t = 8; t < size - 8; t++) {
      if (!reserved[6][t]) set(6, t, t % 2 === 0);
      if (!reserved[t][6]) set(t, 6, t % 2 === 0);
    }

    /* формат-информация (маска 0) + тёмный модуль */
    var MASK = 0;
    var fb = formatBits(MASK);
    for (var fi = 0; fi < 15; fi++) {
      var bit = ((fb >> fi) & 1) === 1;
      if (fi < 6) set(fi, 8, bit);
      else if (fi < 8) set(fi + 1, 8, bit);
      else set(size - 15 + fi, 8, bit);
      if (fi < 8) set(8, size - fi - 1, bit);
      else if (fi < 9) set(8, 15 - fi, bit);
      else set(8, 15 - fi - 1, bit);
    }
    set(size - 8, 8, true);

    /* размещение данных зигзагом с маской 0: (r+c) % 2 == 0 */
    var byteIdx = 0, bitIdx = 7, dir = -1, row = size - 1;
    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      while (true) {
        for (var c4 = 0; c4 < 2; c4++) {
          var cc2 = col - c4;
          if (!reserved[row][cc2]) {
            var dark2 = false;
            if (byteIdx < interleaved.length) dark2 = ((interleaved[byteIdx] >>> bitIdx) & 1) === 1;
            if ((row + cc2) % 2 === 0) dark2 = !dark2; // маска 0
            m[row][cc2] = dark2;
            reserved[row][cc2] = true;
            bitIdx--;
            if (bitIdx === -1) { byteIdx++; bitIdx = 7; }
          }
        }
        row += dir;
        if (row < 0 || row >= size) { row -= dir; dir = -dir; break; }
      }
    }
    return m;
  }

  /* SVG с тихой зоной в 4 модуля, тёмные модули — currentColor либо opts.dark. */
  function svg(text, opts) {
    opts = opts || {};
    var m = build(text);
    var n = m.length, quiet = 4, total = n + quiet * 2;
    var px = opts.size || 160;
    var dark = opts.dark || '#111';
    var light = opts.light || '#fff';
    var rects = '';
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (m[r][c]) rects += '<rect x="' + (c + quiet) + '" y="' + (r + quiet) + '" width="1" height="1"/>';
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + total + ' ' + total + '" width="' + px + '" height="' + px + '" shape-rendering="crispEdges" role="img" aria-label="QR-код карты">' +
      '<rect width="' + total + '" height="' + total + '" fill="' + light + '"/>' +
      '<g fill="' + dark + '">' + rects + '</g></svg>';
  }

  return { svg: svg };
})();
