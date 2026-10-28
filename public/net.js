/*
 * Песчаный фронт — связь с собственным сервером.
 * Даёт игре тот же интерфейс, что и claude.ai: claude.use('room' | 'user' | 'db'),
 * только всё идёт через WebSocket на наш сервер (server.js).
 */
(function () {
  'use strict';
  const LOBBY = '@lobby';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { } },
  };
  function rnd(n) {
    const abc = 'abcdefghijklmnopqrstuvwxyz0123456789', b = new Uint8Array(n);
    crypto.getRandomValues(b);
    let s = '';
    for (const x of b) s += abc[x % 36];
    return s;
  }
  // Секретный токен игрока: по нему сервер узнаёт профиль. Хранится только в этом браузере.
  let token = store.get('sandfront-token');
  if (!token || !/^[a-z0-9]{32}$/.test(token)) { token = rnd(32); store.set('sandfront-token', token); }
  const PEER = rnd(16); // метка этой вкладки, новая при каждой загрузке
  const err = (code, message) => ({ code, message: message || code });

  let ws = null, isOpen = false, uid = null, retry = 0, seq = 0, subSeq = 0;
  const pending = new Map();      // id запроса -> {res, rej, timer}
  const connHandlers = new Set();
  const rooms = new Map();        // имя -> Room
  const subs = new Map();         // id подписки -> {coll, q, cb}
  let readyRes;
  const ready = new Promise(r => { readyRes = r; });

  function send(o) { if (ws && ws.readyState === 1 && isOpen) { ws.send(JSON.stringify(o)); return true; } return false; }
  function request(o, ms) {
    return new Promise((res, rej) => {
      const id = ++seq;
      o.id = id;
      const timer = setTimeout(() => { pending.delete(id); rej(err('upstream_error', 'timeout')); }, ms || 10000);
      pending.set(id, { res, rej, timer });
      if (!send(o)) { clearTimeout(timer); pending.delete(id); rej(err('upstream_error', 'offline')); }
    });
  }
  function settle(id, fn) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    fn(p);
  }
  function setConn(v) {
    if (isOpen === v) return;
    isOpen = v;
    for (const h of connHandlers) { try { h(v); } catch (e) { } }
  }

  function connect() {
    // SF_SERVER is set by builds hosted elsewhere (Yandex Games) to reach our own server
    const url = window.SF_SERVER || ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    try { ws = new WebSocket(url); } catch (e) { return reconnectLater(); }
    const me = ws;
    ws.onopen = () => { me.send(JSON.stringify({ t: 'hello', peer: PEER, token })); };
    ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } onMsg(m); };
    ws.onclose = () => {
      if (ws !== me) return;
      ws = null;
      setConn(false);
      for (const id of Array.from(pending.keys())) settle(id, p => p.rej(err('upstream_error', 'offline')));
      reconnectLater();
    };
    ws.onerror = () => { };
  }
  function reconnectLater() {
    retry = Math.min(retry + 1, 6);
    setTimeout(connect, [0, 500, 1000, 2000, 4000, 6000, 8000][retry]);
  }

  function onMsg(m) {
    switch (m.t) {
      case 'welcome':
        uid = m.uid; retry = 0;
        setConn(true);
        readyRes(true);
        // После переподключения возвращаемся во все комнаты и подписки.
        for (const r of rooms.values()) if (r.joined) r.rejoin();
        for (const [sub, s] of subs) send({ t: 'db', op: 'sub', sub, coll: s.coll, q: s.q });
        break;
      case 'joined': {
        const r = rooms.get(m.room);
        if (r) r.reset(m.peers || []);
        settle(m.id, p => p.res(m));
        break;
      }
      case 'left': settle(m.id, p => p.res()); break;
      case 'err': settle(m.id, p => p.rej(err(m.code || 'upstream_error'))); break;
      case 'pj': case 'pf': { const r = rooms.get(m.room); if (r) r.setPeer(m.peer, m.pres || {}); break; }
      case 'pp': { const r = rooms.get(m.room); if (r) r.patchPeer(m.peer, m.patch || {}); break; }
      case 'pl': { const r = rooms.get(m.room); if (r) r.dropPeer(m.peer); break; }
      case 'dbr': settle(m.id, p => m.ok ? p.res(m) : p.rej(err(m.code || 'upstream_error'))); break;
      case 'dbs': { const s = subs.get(m.sub); if (s) { try { s.cb(qsnap(m.docs)); } catch (e) { } } break; }
    }
  }

  /* ---------- room ---------- */
  function mergeInto(obj, patch) {
    const o = Object.assign({}, obj);
    for (const k of Object.keys(patch)) { if (patch[k] === null) delete o[k]; else o[k] = patch[k]; }
    return o;
  }
  function makePeer(peer, presence, self) {
    return Object.freeze({ peer, by: null, isMe: !!self, sameTab: !!self, kind: 'viewer', guest: false, presence: Object.freeze(presence), updatedAt: Date.now() });
  }
  class Room {
    constructor(name) {
      this.name = name;
      this.joined = false;
      this.dead = false;
      this.members = new Map(); // peer -> frozen Peer (кроме себя)
      this.selfPres = {};
      this.self = makePeer(PEER, {}, true);
      this.handlers = new Set();
      this.snap = null;
      this.j = new Map(); this.u = new Map(); this.l = new Map();
      this.flushT = 0;
      this.out = null;
    }
    // изменения копятся и уходят игре одним пакетом (как на claude.ai — не чаще раза за кадр)
    markJoined(p) { if (this.l.has(p)) { this.l.delete(p); this.u.set(p, 1); } else this.j.set(p, 1); this.dirty(); }
    markUpdated(p) { if (!this.j.has(p)) this.u.set(p, 1); this.dirty(); }
    markLeft(p, obj) { if (this.j.has(p)) this.j.delete(p); else { this.u.delete(p); this.l.set(p, obj); } this.dirty(); }
    dirty() {
      this.snap = null;
      if (!this.flushT) this.flushT = setTimeout(() => this.flush(), 16);
    }
    get(p) { return p === PEER ? this.self : this.members.get(p); }
    flush() {
      this.flushT = 0;
      if (this.dead) return;
      const peers = this.peers();
      const pick = m => Array.from(m.keys()).map(p => this.get(p)).filter(Boolean);
      const change = { peers, joined: pick(this.j), updated: pick(this.u), left: Array.from(this.l.values()) };
      this.j.clear(); this.u.clear(); this.l.clear();
      if (!change.joined.length && !change.updated.length && !change.left.length) return;
      for (const h of Array.from(this.handlers)) { try { h(change); } catch (e) { console.error(e); } }
    }
    peers() {
      if (!this.snap) this.snap = Object.freeze([this.self].concat(Array.from(this.members.values())));
      return this.snap;
    }
    onPeers(handler, onError) {
      if (typeof handler !== 'function') throw new TypeError('handler must be a function');
      this.handlers.add(handler);
      // Первая доставка: вся комната как «вошли», включая себя.
      queueMicrotask(() => {
        if (!this.handlers.has(handler)) return;
        const peers = this.peers();
        try { handler({ peers, joined: peers, updated: [], left: [] }); } catch (e) { console.error(e); }
      });
      return () => { this.handlers.delete(handler); };
    }
    presence(patch) {
      if (this.dead) return Promise.reject(err('invalid_argument', 'room left'));
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return Promise.reject(err('invalid_argument'));
      this.selfPres = mergeInto(this.selfPres, patch);
      this.self = makePeer(PEER, this.selfPres, true);
      this.markUpdated(PEER);
      if (this.joined) {
        // несколько вызовов подряд уходят одним сообщением
        if (!this.out) { this.out = {}; queueMicrotask(() => { const o = this.out; this.out = null; if (o && !this.dead) send({ t: 'pres', room: this.name, patch: o }); }); }
        Object.assign(this.out, patch);
      }
      return Promise.resolve();
    }
    // полный список других игроков после входа/переподключения
    reset(list) {
      const seen = new Set();
      for (const x of list) {
        if (!x || typeof x.peer !== 'string' || x.peer === PEER) continue;
        seen.add(x.peer);
        this.setPeer(x.peer, x.pres || {});
      }
      for (const [p, obj] of Array.from(this.members)) if (!seen.has(p)) { this.members.delete(p); this.markLeft(p, obj); }
    }
    setPeer(peer, pres) {
      if (peer === PEER) return;
      const had = this.members.has(peer);
      this.members.set(peer, makePeer(peer, pres, false));
      had ? this.markUpdated(peer) : this.markJoined(peer);
    }
    patchPeer(peer, patch) {
      const cur = this.members.get(peer);
      if (!cur) return this.setPeer(peer, mergeInto({}, patch));
      this.members.set(peer, makePeer(peer, mergeInto(cur.presence, patch), false));
      this.markUpdated(peer);
    }
    dropPeer(peer) {
      const cur = this.members.get(peer);
      if (!cur) return;
      this.members.delete(peer);
      this.markLeft(peer, cur);
    }
    rejoin() { send({ t: 'join', id: ++seq, room: this.name, pres: this.selfPres }); }
    connected() { return isOpen; }
    onConnection(handler) {
      if (typeof handler !== 'function') throw new TypeError('handler must be a function');
      connHandlers.add(handler);
      queueMicrotask(() => { if (connHandlers.has(handler)) { try { handler(isOpen); } catch (e) { } } });
      return () => { connHandlers.delete(handler); };
    }
    emit() { return Promise.resolve(); }
    on() { return () => { }; }
    leave() {
      if (this.dead) return Promise.resolve();
      this.dead = true;
      this.handlers.clear();
      rooms.delete(this.name);
      send({ t: 'leave', room: this.name });
      return Promise.resolve();
    }
  }
  async function enter(name) {
    const have = rooms.get(name);
    if (have) return have;
    const r = new Room(name);
    rooms.set(name, r);
    try {
      await request({ t: 'join', room: name, pres: {} });
      r.joined = true;
      return r;
    } catch (e) {
      rooms.delete(name);
      r.dead = true;
      throw e;
    }
  }

  /* ---------- db ---------- */
  function docSnap(id, exists, data) {
    return { id, exists, data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined) };
  }
  function qsnap(docs) {
    const list = (docs || []).map(d => docSnap(d.id, true, d.data));
    return { docs: list, size: list.length, empty: !list.length };
  }
  function query(coll, q) {
    return {
      where(f, op, v) { return query(coll, Object.assign({}, q, { where: (q.where || []).concat([[f, op, v]]) })); },
      orderBy(f, dir) { return query(coll, Object.assign({}, q, { orderBy: [f, dir === 'desc' ? 'desc' : 'asc'] })); },
      limit(n) { return query(coll, Object.assign({}, q, { limit: n | 0 })); },
      get() { return request({ t: 'db', op: 'query', coll, q }).then(r => qsnap(r.docs)); },
      onSnapshot(cb, onError) {
        const sub = ++subSeq;
        subs.set(sub, { coll, q, cb });
        send({ t: 'db', op: 'sub', sub, coll, q });
        return () => { subs.delete(sub); send({ t: 'db', op: 'unsub', sub }); };
      },
    };
  }
  const db = {
    doc(path) {
      const id = String(path).split('/').pop();
      return {
        id,
        get() { return request({ t: 'db', op: 'get', path }).then(r => docSnap(id, !!r.exists, r.data)); },
        set(data) { return request({ t: 'db', op: 'set', path, data }).then(() => undefined); },
      };
    },
    collection(name) { return query(name, {}); },
  };

  /* ---------- user ---------- */
  const user = {
    id() { return ready.then(() => uid); },
    canEdit() { return Promise.resolve(false); },
    profiles() { return Promise.resolve([]); },
  };

  /* ---------- claude.use ---------- */
  function waitReady(ms) { return Promise.race([ready, new Promise(r => setTimeout(() => r(false), ms))]); }
  async function use(name) {
    if (!(await waitReady(10000))) return null;
    if (name === 'room') {
      const lobby = await enter(LOBBY).catch(() => null);
      if (!lobby) return null;
      lobby.join = n => (typeof n === 'string' && /^[a-z0-9][a-z0-9_.-]{0,47}$/.test(n)) ? enter(n) : Promise.reject(err('invalid_argument'));
      return lobby;
    }
    if (name === 'user') return user;
    if (name === 'db') return db;
    return null;
  }

  window.claude = { use };
  connect();
})();
