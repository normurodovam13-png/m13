'use strict';
/*
 * Песчаный фронт — игровой сервер.
 * Раздаёт игру (папка public) и по WebSocket (/ws) заменяет возможности claude.ai:
 *   room — лобби и комнаты с «присутствием» игроков (состояние матча идёт через него);
 *   user — постоянный id игрока (по секретному токену из браузера);
 *   db   — профили и рейтинг (файл data/db.json).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const LOBBY = '@lobby';
const ROOM_RE = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
const PEER_RE = /^[a-z0-9]{8,32}$/;
const TOKEN_RE = /^[a-z0-9]{32}$/;
const SEG_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_ROOM = 24;        // человек в одной комнате
const MAX_ROOMS_PER = 17;   // комнат на одну вкладку (лобби + 16)
const MAX_PRES = 6 * 1024;  // байт присутствия на человека
const MAX_DOC = 4 * 1024;   // байт на документ
const MAX_DOCS = 20000;
const GRACE_MS = 15000;     // сколько ждём переподключения после обрыва (подвис ПК, моргнул Wi-Fi)

/* ---------- Раздача файлов ---------- */
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
const fileCache = new Map(); // путь -> {mtime, raw, gz}
function loadFile(file) {
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error('not a file');
  const c = fileCache.get(file);
  if (c && c.mtime === st.mtimeMs) return c;
  const raw = fs.readFileSync(file);
  const gz = /\.(html|js|css|json|svg)$/.test(file) ? zlib.gzipSync(raw) : null;
  const e = { mtime: st.mtimeMs, raw, gz };
  fileCache.set(file, e);
  return e;
}
const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); return res.end(); }
  if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let p;
  try { p = decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  let f;
  try { f = loadFile(file); } catch (e) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Не найдено');
  }
  const useGz = f.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const headers = { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', 'vary': 'accept-encoding' };
  if (useGz) headers['content-encoding'] = 'gzip';
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : (useGz ? f.gz : f.raw));
});

/* ---------- Хранилище (профили, настройки) ---------- */
let DB = {};
try { DB = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) || {}; } catch (e) { DB = {}; }
let saveT = null;
function saveDB() {
  if (saveT) return;
  saveT = setTimeout(() => {
    saveT = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(DB));
      fs.renameSync(DB_FILE + '.tmp', DB_FILE);
    } catch (e) { console.error('Не удалось сохранить базу:', e.message); }
  }, 1500);
}
function splitPath(p) {
  if (typeof p !== 'string' || p.length > 200) return null;
  const s = p.split('/');
  return s.every(x => SEG_RE.test(x)) ? s : null;
}
// Кто что может читать и писать.
function canRead(seg, uid) {
  if (seg.length === 2 && seg[0] === 'players') return true;
  if (seg.length === 4 && seg[0] === 'data' && seg[1] === 'users' && seg[2] === uid && seg[3] === 'settings') return true;
  return false;
}
function canWrite(seg, uid) {
  if (seg.length === 2 && seg[0] === 'players' && seg[1] === uid) return true;
  if (seg.length === 4 && seg[0] === 'data' && seg[1] === 'users' && seg[2] === uid && seg[3] === 'settings') return true;
  return false;
}
function collDocs(coll) {
  const pre = coll + '/', out = [];
  for (const k in DB) if (k.startsWith(pre) && k.indexOf('/', pre.length) < 0) out.push({ id: k.slice(pre.length), data: DB[k] });
  return out;
}
function runQuery(coll, q) {
  q = q && typeof q === 'object' ? q : {};
  let docs = collDocs(coll);
  if (Array.isArray(q.where)) for (const w of q.where.slice(0, 4)) {
    if (!Array.isArray(w) || w[1] !== '==' || typeof w[0] !== 'string') continue;
    docs = docs.filter(d => d.data && d.data[w[0]] === w[2]);
  }
  if (Array.isArray(q.orderBy) && typeof q.orderBy[0] === 'string') {
    const f = q.orderBy[0], k = q.orderBy[1] === 'desc' ? -1 : 1;
    docs.sort((a, b) => {
      const x = a.data ? a.data[f] : undefined, y = b.data ? b.data[f] : undefined;
      return (x === y ? 0 : x === undefined ? 1 : y === undefined ? -1 : x < y ? -1 : 1) * k;
    });
  }
  const lim = Math.max(1, Math.min(50, (q.limit | 0) || 50));
  return docs.slice(0, lim);
}

/* ---------- Комнаты ---------- */
const rooms = new Map(); // имя -> Map(peer -> {peer, sock, pres, gone})
const socksByPeer = new Map();
function out(sock, obj) { if (sock && sock.readyState === 1) sock.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); }
function broadcast(room, exceptPeer, obj) {
  const r = rooms.get(room);
  if (!r) return;
  const s = JSON.stringify(obj);
  for (const m of r.values()) if (m.peer !== exceptPeer) out(m.sock, s);
}
function removeMember(room, peer) {
  const r = rooms.get(room);
  if (!r) return;
  const m = r.get(peer);
  if (!m) return;
  if (m.gone) { clearTimeout(m.gone); console.log(new Date().toISOString().slice(11, 19), 'не вернулся, убран из', room, peer.slice(0, 4)); }
  if (m.later) clearTimeout(m.later);
  r.delete(peer);
  if (m.sock && m.sock.rooms) m.sock.rooms.delete(room);
  broadcast(room, peer, { t: 'pl', room, peer });
  if (!r.size) rooms.delete(room);
}
function cleanPres(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return {};
  const o = {};
  for (const k of Object.keys(p).slice(0, 64)) if (p[k] !== null && p[k] !== undefined) o[k] = p[k];
  return Buffer.byteLength(JSON.stringify(o)) <= MAX_PRES ? o : {};
}

/* ---------- WebSocket ---------- */
const wss = new WebSocketServer({
  server, path: '/ws', maxPayload: 32 * 1024,
  perMessageDeflate: { threshold: 256, zlibDeflateOptions: { level: 3 } },
});

wss.on('connection', sock => {
  sock.alive = true;
  sock.rooms = new Set();
  sock.subs = new Map();
  sock.budget = 200;
  sock.last = Date.now();
  sock.on('pong', () => { sock.alive = true; });
  sock.on('message', raw => {
    // Ограничение: в среднем 120 сообщений в секунду. Подвисший браузер потом шлёт накопленное пачкой,
    // поэтому сверх лимита присутствие не выбрасываем, а копим (см. 'pres'), остальное — отбрасываем.
    const now = Date.now();
    sock.budget = Math.min(240, sock.budget + (now - sock.last) * 0.12);
    sock.last = now;
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    const over = sock.budget < 1;
    if (!over) sock.budget--;
    else if (!CONTROL.has(m.t)) { if (!sock.warned) { sock.warned = true; console.log(new Date().toISOString().slice(11, 19), 'лимит сообщений', (sock.peer || '?').slice(0, 4)); } return; }
    try { handle(sock, m, over); } catch (e) { console.error('Ошибка обработки:', e); }
  });
  sock.on('close', (code, reason) => {
    if (sock.peer && sock.rooms.size) console.log(new Date().toISOString().slice(11, 19), 'обрыв', sock.peer.slice(0, 4), code, String(reason || ''), [...sock.rooms].join(','));
    if (sock.peer && socksByPeer.get(sock.peer) === sock) socksByPeer.delete(sock.peer);
    // вкладку закрыли сами (1000/1001) — убираем сразу, чтобы хост перешёл к другому без ожидания
    const clean = code === 1000 || code === 1001;
    for (const room of sock.rooms) {
      const r = rooms.get(room);
      const m = r && r.get(sock.peer);
      if (!m || m.sock !== sock) continue;
      m.sock = null;
      if (clean) removeMember(room, m.peer);
      else m.gone = setTimeout(() => removeMember(room, m.peer), GRACE_MS);
    }
    sock.rooms.clear();
    sock.subs.clear();
  });
});

const CONTROL = new Set(['hello', 'join', 'leave', 'pres']);
function handle(sock, m, over) {
  if (m.t === 'hello') {
    if (sock.peer || !PEER_RE.test(m.peer || '') || !TOKEN_RE.test(m.token || '')) return sock.close(4000, 'bad hello');
    const old = socksByPeer.get(m.peer);
    if (old && old !== sock) old.close(4001, 'replaced');
    sock.peer = m.peer;
    sock.uid = crypto.createHash('sha256').update('sandfront:' + m.token).digest('hex').slice(0, 24);
    socksByPeer.set(sock.peer, sock);
    return out(sock, { t: 'welcome', uid: sock.uid });
  }
  if (!sock.peer) return;

  switch (m.t) {
    case 'join': {
      const room = m.room;
      if (room !== LOBBY && !ROOM_RE.test(room || '')) return out(sock, { t: 'err', id: m.id, code: 'invalid_argument' });
      let r = rooms.get(room);
      const existing = r && r.get(sock.peer);
      if (!existing && (sock.rooms.size >= MAX_ROOMS_PER || (r && r.size >= MAX_ROOM))) return out(sock, { t: 'err', id: m.id, code: 'limit_reached' });
      if (!r) { r = new Map(); rooms.set(room, r); }
      const pres = cleanPres(m.pres);
      if (existing) {
        if (existing.gone) { clearTimeout(existing.gone); existing.gone = null; }
        existing.sock = sock;
        existing.pres = pres;
        broadcast(room, sock.peer, { t: 'pf', room, peer: sock.peer, pres });
      } else {
        r.set(sock.peer, { peer: sock.peer, sock, pres, gone: null });
        broadcast(room, sock.peer, { t: 'pj', room, peer: sock.peer, pres });
      }
      sock.rooms.add(room);
      const peers = [];
      for (const x of r.values()) if (x.peer !== sock.peer) peers.push({ peer: x.peer, pres: x.pres });
      return out(sock, { t: 'joined', id: m.id, room, peers });
    }
    case 'leave': {
      const r = rooms.get(m.room);
      const x = r && r.get(sock.peer);
      if (x && x.sock === sock) removeMember(m.room, sock.peer);
      return out(sock, { t: 'left', id: m.id });
    }
    case 'pres': {
      const r = rooms.get(m.room);
      const x = r && r.get(sock.peer);
      if (!x || x.sock !== sock || !m.patch || typeof m.patch !== 'object' || Array.isArray(m.patch)) return;
      const next = Object.assign({}, x.pres);
      for (const k of Object.keys(m.patch).slice(0, 64)) { if (m.patch[k] === null) delete next[k]; else next[k] = m.patch[k]; }
      if (Buffer.byteLength(JSON.stringify(next)) > MAX_PRES) return;
      x.pres = next;
      // сверх лимита: изменение сохранено, остальным разошлём полное присутствие одним сообщением чуть позже
      if (over || x.later) {
        if (!x.later) x.later = setTimeout(() => { x.later = null; if (rooms.get(m.room)?.get(x.peer) === x) broadcast(m.room, x.peer, { t: 'pf', room: m.room, peer: x.peer, pres: x.pres }); }, 250);
        return;
      }
      return broadcast(m.room, sock.peer, { t: 'pp', room: m.room, peer: sock.peer, patch: m.patch });
    }
    case 'db': return handleDb(sock, m);
  }
}

function handleDb(sock, m) {
  const reply = o => out(sock, Object.assign({ t: 'dbr', id: m.id }, o));
  if (m.op === 'get') {
    const seg = splitPath(m.path);
    if (!seg || seg.length % 2 || !canRead(seg, sock.uid)) return reply({ ok: false, code: 'not_permitted' });
    const d = DB[seg.join('/')];
    return reply({ ok: true, exists: d !== undefined, data: d === undefined ? null : d });
  }
  if (m.op === 'set') {
    const seg = splitPath(m.path);
    if (!seg || seg.length % 2 || !canWrite(seg, sock.uid)) return reply({ ok: false, code: 'not_permitted' });
    if (!m.data || typeof m.data !== 'object' || Array.isArray(m.data)) return reply({ ok: false, code: 'invalid_argument' });
    const json = JSON.stringify(m.data);
    if (Buffer.byteLength(json) > MAX_DOC) return reply({ ok: false, code: 'invalid_argument' });
    const key = seg.join('/');
    if (DB[key] === undefined && Object.keys(DB).length >= MAX_DOCS) return reply({ ok: false, code: 'limit_reached' });
    DB[key] = JSON.parse(json);
    saveDB();
    reply({ ok: true });
    return notifySubs(seg.slice(0, -1).join('/'));
  }
  if (m.op === 'query') {
    if (m.coll !== 'players') return reply({ ok: false, code: 'not_permitted' });
    return reply({ ok: true, docs: runQuery(m.coll, m.q) });
  }
  if (m.op === 'sub') {
    if (m.coll !== 'players' || typeof m.sub !== 'number' || sock.subs.size >= 8) return;
    sock.subs.set(m.sub, { coll: m.coll, q: m.q });
    return out(sock, { t: 'dbs', sub: m.sub, docs: runQuery(m.coll, m.q) });
  }
  if (m.op === 'unsub') sock.subs.delete(m.sub);
}
const notifyPending = new Set();
function notifySubs(coll) {
  // Не чаще раза в секунду на коллекцию: после матча все пишут профили одновременно.
  if (notifyPending.has(coll)) return;
  notifyPending.add(coll);
  setTimeout(() => {
    notifyPending.delete(coll);
    for (const sock of wss.clients) for (const [sub, s] of sock.subs) {
      if (s.coll === coll) out(sock, { t: 'dbs', sub, docs: runQuery(coll, s.q) });
    }
  }, 1000);
}

// Пинг, чтобы хостинг не рвал тихие соединения и чтобы находить «мёртвые».
setInterval(() => {
  for (const sock of wss.clients) {
    if (!sock.alive) { console.log(new Date().toISOString().slice(11, 19), 'нет ответа на пинг', (sock.peer || '?').slice(0, 4)); sock.terminate(); continue; }
    sock.alive = false;
    try { sock.ping(); } catch (e) { }
  }
}, 25000);

server.listen(PORT, () => console.log('Песчаный фронт: сервер запущен на порту ' + PORT));
