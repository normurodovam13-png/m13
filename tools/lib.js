'use strict';
// Общие инструменты генератора карт: сетка 100×100 клеток по 1 м, рельеф, ящики, декорации.
const zlib = require('zlib');

const W = 100, H = 100;
// Алфавит высот: индекс * 0.25 - 6  →  от -6 до +15.5 м. Без кавычек, слэшей и '#'.
const HALPH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!$%&()*+,-.:;<=>?@[]^_{|}~';
const encH = v => {
  const i = Math.round((v + 6) * 4);
  if (i < 0 || i >= HALPH.length) throw new Error('высота вне диапазона: ' + v);
  return HALPH[i];
};

function seeded(s) { return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; }
const q4 = v => Math.round(v * 4) / 4;
const r2 = v => Math.round(v * 100) / 100;

class MapBuilder {
  constructor(id, seed) {
    this.id = id;
    this.k = new Array(W * H).fill('#');
    this.h = new Float32Array(W * H);
    this.props = [];
    this.rng = seeded(seed || 1234);
    // По умолчанию стены — «дома» разной высоты кварталами 6×6.
    const blocks = {};
    for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
      const key = (x / 6 | 0) + ',' + (z / 6 | 0);
      if (!(key in blocks)) blocks[key] = 6 + Math.floor(this.rng() * 7) * 0.5;
      this.h[z * W + x] = blocks[key];
    }
  }
  i(x, z) { return z * W + x; }
  inb(x, z) { return x >= 0 && z >= 0 && x < W && z < H; }
  each(x0, z0, x1, z1, fn) {
    const ax = Math.min(x0, x1), bx = Math.max(x0, x1), az = Math.min(z0, z1), bz = Math.max(z0, z1);
    for (let z = az; z <= bz; z++) for (let x = ax; x <= bx; x++) if (this.inb(x, z)) fn(x, z, this.i(x, z));
  }
  // Пол (включительно по обоим концам).
  floor(x0, z0, x1, z1, f = 0, ch = '.') { this.each(x0, z0, x1, z1, (x, z, i) => { this.k[i] = ch; this.h[i] = q4(f); }); return this; }
  // Стена с верхом на высоте top.
  wall(x0, z0, x1, z1, top = 7) { this.each(x0, z0, x1, z1, (x, z, i) => { this.k[i] = '#'; this.h[i] = q4(top); }); return this; }
  // Поменять высоту уже стоящих стен в прямоугольнике.
  wallH(x0, z0, x1, z1, top) { this.each(x0, z0, x1, z1, (x, z, i) => { if (this.k[i] === '#') this.h[i] = q4(top); }); return this; }
  // Пандус: высота меняется от f0 до f1 вдоль оси ('x' — слева направо, 'z' — сверху вниз).
  ramp(x0, z0, x1, z1, axis, f0, f1, ch = '.') {
    const a0 = axis === 'x' ? x0 : z0, a1 = axis === 'x' ? x1 : z1, n = Math.max(1, Math.abs(a1 - a0));
    this.each(x0, z0, x1, z1, (x, z, i) => {
      const a = axis === 'x' ? x : z, t = Math.abs(a - a0) / n;
      this.k[i] = ch; this.h[i] = q4(f0 + (f1 - f0) * t);
    });
    return this;
  }
  // Ящики: высокий 'C' (2.3 м) или низкий 'c' (0.9 м), стоят на текущем полу.
  crate(x0, z0, x1, z1, big = true) { this.each(x0, z0, x1, z1, (x, z, i) => { if (this.k[i] !== '#') this.k[i] = big ? 'C' : 'c'; }); return this; }
  // Твёрдый объект без своей отрисовки (её даёт декорация), стоит на текущем полу.
  // Тип = высота: 'o' 1.1 м (бочка), 'q' 1.4 м (машина), 'Q' 2.6 м (контейнер), 'O' 3 м (столб, пальма), 'W' 3.7 м (вагон).
  solid(x0, z0, x1, z1, t = 'o') { this.each(x0, z0, x1, z1, (x, z, i) => { if (this.k[i] !== '#') this.k[i] = t; }); return this; }
  site(L, x0, z0, x1, z1) { this.each(x0, z0, x1, z1, (x, z, i) => { if (this.k[i] === '.') this.k[i] = L; }); return this; }
  spawn(team, x0, z0, x1, z1) { return this.site(team === 'T' ? 'T' : 'S', x0, z0, x1, z1); }
  fl(x, z) { return this.h[this.i(x, z)]; }

  /* ---------- декорации (только вид, без столкновений) ---------- */
  // box: центр по x/z, низ по y; размеры w (по x), h, d (по z); r — поворот вокруг вертикали (рад).
  box(x, y, z, w, h, d, m, c, r) { this.props.push(['box', r2(x), r2(y), r2(z), r2(w), r2(h), r2(d), m || 'wall', c || 0, r2(r || 0)]); return this; }
  // прямоугольник клеток → коробка (удобно для арок, крыш, перекрытий)
  span(x0, z0, x1, z1, y, h, m, c) { return this.box((x0 + x1 + 1) / 2, y, (z0 + z1 + 1) / 2, x1 - x0 + 1, h, z1 - z0 + 1, m, c); }
  add(type, ...args) { this.props.push([type, ...args.map(v => typeof v === 'number' ? r2(v) : v)]); return this; }
  // Точка на грани стены: клетка стены (x,z) и сторона, куда смотрит грань ('n','s','e','w').
  face(x, z, side, along = 0.5) {
    const o = 0.04;
    if (side === 'e') return { x: x + 1 + o, z: z + along, r: Math.PI / 2 };
    if (side === 'w') return { x: x - o, z: z + along, r: -Math.PI / 2 };
    if (side === 's') return { x: x + along, z: z + 1 + o, r: 0 };
    return { x: x + along, z: z - o, r: Math.PI };
  }
  sign(x, z, side, text, y, along) { const f = this.face(x, z, side, along); return this.add('sign', f.x, y, f.z, f.r, text); }
  // Окно на грани стены: ширина w, высота h, низ на высоте y, c — цвет ставней (0 — без ставней).
  win(x, z, side, y, w = 1.1, h = 1.4, c = 0, along) { const f = this.face(x, z, side, along); return this.add('win', f.x, y, f.z, f.r, w, h, c); }
  // Ряд окон вдоль стены от a до b (координата вдоль грани), шаг step.
  winRow(side, line, a, b, y, step = 3, w, h, c) {
    for (let t = a; t <= b; t += step) {
      if (side === 'e' || side === 'w') this.win(line, Math.floor(t), side, y, w, h, c, t - Math.floor(t) + 0.5);
      else this.win(Math.floor(t), line, side, y, w, h, c, t - Math.floor(t) + 0.5);
    }
    return this;
  }
  // Навес, прикреплённый к грани стены: ширина w, вылет d.
  awning(x, z, side, y, w, d, c, along) { const f = this.face(x, z, side, along); return this.add('awning', f.x, y, f.z, w, d, f.r, c); }

  export() {
    const k = [], h = [];
    for (let z = 0; z < H; z++) {
      let a = '', b = '';
      for (let x = 0; x < W; x++) { const i = this.i(x, z); a += this.k[i]; b += encH(this.h[i]); }
      k.push(a); h.push(b);
    }
    return { k, h, p: this.props };
  }
}

/* ---------- проверка проходимости ---------- */
const WALK = ch => ch === '.' || ch === 'A' || ch === 'B' || ch === 'T' || ch === 'S';
function validate(m) {
  const { k, h } = m;
  let start = -1;
  for (let i = 0; i < W * H; i++) if (k[i] === 'T') { start = i; break; }
  const seen = new Uint8Array(W * H), q = [start];
  seen[start] = 1;
  while (q.length) {
    const c = q.shift(), cx = c % W, cz = (c / W) | 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= W || nz >= H) continue;
      const n = nz * W + nx;
      if (seen[n] || !WALK(k[n]) || Math.abs(h[n] - h[c]) > 0.55) continue;
      seen[n] = 1; q.push(n);
    }
  }
  const cnt = { T: 0, S: 0, A: 0, B: 0 }, miss = { T: 0, S: 0, A: 0, B: 0 };
  let walk = 0, unreach = 0, border = 0;
  const lost = [];
  for (let i = 0; i < W * H; i++) {
    const ch = k[i], x = i % W, z = (i / W) | 0;
    if ((x === 0 || z === 0 || x === W - 1 || z === H - 1) && ch !== '#') border++;
    if (WALK(ch)) { walk++; if (!seen[i]) { unreach++; if (lost.length < 12) lost.push(x + ',' + z); } }
    if (ch in cnt) { cnt[ch]++; if (!seen[i]) miss[ch]++; }
  }
  return { walk, unreach, lost, border, cnt, miss, seen };
}

/* ---------- картинка-план ---------- */
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(w, hgt, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * hgt);
  for (let y = 0; y < hgt; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(hgt, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// Мелкий растровый шрифт для подписей на плане (цифры координат).
const DIG = { '0': '111101101101111', '1': '010110010010111', '2': '111001111100111', '3': '111001111001111', '4': '101101111001001', '5': '111100111001111', '6': '111100111101111', '7': '111001001001001', '8': '111101111101111', '9': '111101111001111' };
function preview(m, val, labels) {
  const P = 7, w = W * P + 24, hh = H * P + 24, img = Buffer.alloc(w * hh * 3, 30);
  const px = (x, y, c) => { if (x < 0 || y < 0 || x >= w || y >= hh) return; const o = (y * w + x) * 3; img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2]; };
  const rect = (x, y, a, b, c) => { for (let j = 0; j < b; j++) for (let i = 0; i < a; i++) px(x + i, y + j, c); };
  const text = (s, x, y, c) => { for (const ch of s) { const g = DIG[ch]; if (g) for (let j = 0; j < 5; j++) for (let i = 0; i < 3; i++) if (g[j * 3 + i] === '1') px(x + i, y + j, c); x += 4; } };
  const O = 24;
  for (let t = 0; t < W; t += 10) { text(String(t), O + t * P, 4, [220, 220, 220]); text(String(t), 2, O + t * P, [220, 220, 220]); }
  for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
    const i = z * W + x, ch = m.k[i], f = m.h[i];
    let c;
    if (ch === '#') { const v = 40 + Math.min(60, f * 5); c = [v, v, v + 6]; }
    else if (ch === 'C') c = [120, 80, 40];
    else if (ch === 'c') c = [170, 120, 60];
    else if ('oOqQW'.includes(ch)) c = [140, 70, 160];
    else {
      const l = Math.max(60, Math.min(255, 175 + f * 18));
      c = [l, l * 0.88, l * 0.62];
      if (ch === 'A' || ch === 'B') c = [l, l * 0.5, l * 0.4];
      if (ch === 'T') c = [235, 150, 70];
      if (ch === 'S') c = [90, 140, 230];
      if (val && !val.seen[i]) c = [255, 0, 255];
    }
    rect(O + x * P, O + z * P, P, P, c);
    if (x % 10 === 0 || z % 10 === 0) px(O + x * P, O + z * P, [255, 255, 255]);
  }
  // контуры декораций
  for (const p of m.props) {
    if (p[0] !== 'box') { const x = p[1], z = p[3]; rect(O + Math.round(x * P) - 2, O + Math.round(z * P) - 2, 5, 5, [40, 200, 90]); continue; }
    const [, x, , z, bw, , bd] = p;
    const x0 = O + Math.round((x - bw / 2) * P), x1 = O + Math.round((x + bw / 2) * P), z0 = O + Math.round((z - bd / 2) * P), z1 = O + Math.round((z + bd / 2) * P);
    for (let a = x0; a <= x1; a++) { px(a, z0, [60, 230, 230]); px(a, z1, [60, 230, 230]); }
    for (let b = z0; b <= z1; b++) { px(x0, b, [60, 230, 230]); px(x1, b, [60, 230, 230]); }
  }
  return png(w, hh, img);
}

module.exports = { W, H, HALPH, MapBuilder, validate, preview, seeded };
