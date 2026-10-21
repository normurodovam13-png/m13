'use strict';
// Скриншоты и проверки игры в Chrome без окна (через DevTools Protocol).
// node tools/shot.js views <карта> [вид ...]   — снимки с точек из tools/views.json
// node tools/shot.js play <карта> [секунд]      — матч с ботами: ошибки, движение ботов, раунды
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path');
const CHROME = process.env.CHROME || 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe';
const URL_ = process.env.GAME_URL || 'http://localhost:3999/?debug';
const OUT = path.join(__dirname, 'out', 'shots');
const PROFILE = process.env.CHROME_PROFILE || path.join(require('os').tmpdir(), 'sandfront-chrome');
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let chrome = null;
async function main() {
  const [mode, mapId, ...rest] = process.argv.slice(2);
  const port = 9300 + Math.floor(Math.random() * 500);
  chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + PROFILE, '--window-size=1280,720',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-first-run', '--no-default-browser-check', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); target = list.find(t => t.type === 'page'); } catch (e) { }
  }
  if (!target) throw new Error('Chrome не запустился');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const wait = new Map(); const errors = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) errors.push(m.params.type + ' ' + m.params.args.map(a => a.value ?? a.description).join(' '));
  };
  const cmd = (method, params = {}) => new Promise(res => { const i = ++id; wait.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => { const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval error'); return r.result.result.value; };
  await cmd('Runtime.enable'); await cmd('Page.enable');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await cmd('Page.navigate', { url: URL_ });
  for (let i = 0; i < 100; i++) { await sleep(200); if (await ev('!!window.__sf').catch(() => false)) break; }
  if (!(await ev('!!window.__sf'))) throw new Error('игра не загрузилась:\n' + errors.join('\n') + '\n' + await ev('document.body.innerText.slice(0,300)'));
  const t0 = Date.now();
  await ev(`__sf.loadMap(${JSON.stringify(mapId)})`);
  console.log('карта загружена за ' + (Date.now() - t0) + ' мс, текущая: ' + await ev('__sf.CUR_MAP'));
  const shot = async name => { const r = await cmd('Page.captureScreenshot', { format: 'png' }); const f = path.join(OUT, `${mapId}-${name}.png`); fs.writeFileSync(f, Buffer.from(r.result.data, 'base64')); console.log('снимок ' + f); };

  if (mode === 'views') {
    const views = JSON.parse(fs.readFileSync(path.join(__dirname, 'views.json'), 'utf8'))[mapId] || {};
    await ev(`for(const el of document.body.children)if(el.id!=='app'&&el.tagName!=='SCRIPT')el.style.display='none'`);
    for (const [name, v] of Object.entries(views)) {
      if (rest.length && !rest.includes(name)) continue;
      await ev(`__sf.DBG.cam=${JSON.stringify({ x: v[0], y: v[1], z: v[2], yaw: v[3], pitch: v[4] || 0 })}`);
      await sleep(700);
      await shot(name);
    }
  } else if (mode === 'ui') {
    // node tools/shot.js ui <карта> [клавиши через запятую]: снимок интерфейса после каждой клавиши (KeyB, Digit4, Tab...)
    await ev(`__sf.settings.perTeam=5;__sf.settings.team=${JSON.stringify(process.env.TEAM || 'CT')};__sf.settings.map=${JSON.stringify(mapId)};__sf.settings.mode=${JSON.stringify(process.env.MODE||'classic')};__sf.startOffline()`);
    await ev(`__sf.sim(${+(process.env.SIMSEC || 1)})`);
    await sleep(1500);
    await shot('ui-0');
    const keys = String(rest[0] || '').split(',').filter(Boolean);
    let n = 0;
    for (const k of keys) {
      const hold = k.startsWith('+');
      const code = hold ? k.slice(1) : k;
      const key = code.startsWith('Key') ? code.slice(3).toLowerCase() : code.startsWith('Digit') ? code.slice(5) : code;
      await cmd('Input.dispatchKeyEvent', { type: 'keyDown', code, key, windowsVirtualKeyCode: code === 'Tab' ? 9 : key.toUpperCase().charCodeAt(0) });
      if (!hold) await cmd('Input.dispatchKeyEvent', { type: 'keyUp', code, key, windowsVirtualKeyCode: code === 'Tab' ? 9 : key.toUpperCase().charCodeAt(0) });
      await sleep(900);
      await shot('ui-' + (++n) + '-' + code);
    }
  } else if (mode === 'menu') {
    // node tools/shot.js menu <карта> ['js перед снимком']
    if (rest[0]) await ev(rest[0]);
    await sleep(1200);
    await shot('menu');
  } else if (mode === 'vm') {
    // node tools/shot.js vm <карта> usps,ak47,knife — оружие в руках
    await ev(`__sf.settings.perTeam=1;__sf.settings.team=${JSON.stringify(process.env.TEAM || 'CT')};__sf.settings.map=${JSON.stringify(mapId)};__sf.settings.mode=${JSON.stringify(process.env.MODE||'classic')};__sf.startOffline()`);
    await ev('__sf.sim(1)');
    for (const id of String(rest[0] || 'usps,ak47,knife,awp').split(',')) {
      await ev(`__sf.give(${JSON.stringify(id)})`);
      await sleep(1600);
      await shot('vm-' + id);
    }
  } else if (mode === 'probe') {
    // node tools/shot.js probe <карта> <секунд> '<выражение>' — запускает матч, проматывает время и печатает выражение
    await ev(`__sf.settings.perTeam=5;__sf.settings.team=${JSON.stringify(process.env.TEAM || 'CT')};__sf.settings.map=${JSON.stringify(mapId)};__sf.settings.mode=${JSON.stringify(process.env.MODE||'classic')};__sf.startOffline()`);
    const steps = String(rest[0] || '20').split(',').map(Number);
    for (const sec of steps) { await ev(`__sf.sim(${sec})`); console.log('--- после ' + sec + ' с:\n' + await ev(rest[1])); }
  } else if (mode === 'sim') {
    // Быстрая симуляция матча без отрисовки: итоги раундов, закладки, «застрявшие» боты.
    const rounds = +rest[0] || 6;
    await ev(`__sf.settings.perTeam=5;__sf.settings.rounds=13;__sf.settings.team=${JSON.stringify(process.env.TEAM||'CT')};__sf.settings.map=${JSON.stringify(mapId)};__sf.settings.mode=${JSON.stringify(process.env.MODE||'classic')};__sf.startOffline()`);
    const st = () => ev(`JSON.stringify({st:__sf.G.state,ph:__sf.G.phase,round:__sf.G.round,score:__sf.G.score,w:__sf.G.winner,why:__sf.G.why,bomb:__sf.G.bomb.state,site:__sf.G.bomb.site||'',
      bots:__sf.G.ents.filter(e=>e.ctrl==='bot').map(e=>[e.id,+e.pos.x.toFixed(1),+e.pos.z.toFixed(1),e.alive?1:0,e.kills,e.deaths,(e.prim&&e.prim.id)||(e.sec&&e.sec.id)||'-',e.money])})`).then(JSON.parse);
    let s = await st(), lastRound = s.round, travel = {}, prevPos = {}, plants = { A: 0, B: 0 }, planted = false, results = [], t = 0;
    const WHY = ['все убиты', 'время вышло', 'бомба взорвалась', 'бомба обезврежена'];
    while (results.length < rounds && t < rounds * 200) {
      await ev('__sf.sim(2)'); t += 2;
      s = await st();
      if (s.bomb === 'planted' && !planted) { planted = true; plants[s.site] = (plants[s.site] || 0) + 1; }
      if (s.ph === 'live') for (const b of s.bots) { if (!b[3]) continue; const p = prevPos[b[0]]; if (p) travel[b[0]] = (travel[b[0]] || 0) + Math.hypot(b[1] - p[0], b[2] - p[1]); prevPos[b[0]] = [b[1], b[2]]; }
      if ((s.ph === 'end' || s.st !== 'playing') && results.length < s.round) {
        results.push(`раунд ${s.round}: победили ${s.w} (${WHY[s.why] || s.why}), счёт ${s.score.CT}:${s.score.T}`);
        console.log(results[results.length - 1] + ', живы T ' + s.bots.filter(b => b[0][0] === 't' && b[3]).length + ' CT ' + s.bots.filter(b => b[0][0] === 'c' && b[3]).length + ', бомба ' + (planted ? 'заложена' : 'нет') + ', пройдено ботами: ' + Object.entries(travel).map(([k, v]) => k + '=' + Math.round(v)).join(' '));
        console.log('   ' + s.bots.map(b => b[0] + ':' + b[4] + '/' + b[5] + ' ' + b[6] + ' $' + b[7]).join('  '));
        travel = {}; prevPos = {}; planted = false;
      }
      if (s.ph === 'end' && results.length === s.round && !s.logged) {}
      if (s.st !== 'playing') break;
    }
    console.log('закладки: A ' + plants.A + ', B ' + plants.B + '; игровых секунд ' + t);
  } else if (mode === 'play') {
    const secs = +rest[0] || 30;
    await ev(`__sf.settings.perTeam=5;__sf.settings.map=${JSON.stringify(mapId)};__sf.settings.mode=${JSON.stringify(process.env.MODE||'classic')};__sf.startOffline()`);
    const sample = () => ev(`JSON.stringify({st:__sf.G.state,ph:__sf.G.phase,round:__sf.G.round,score:__sf.G.score,bots:__sf.G.ents.filter(e=>e.ctrl==='bot').map(e=>[e.id,+e.pos.x.toFixed(1),+e.pos.z.toFixed(1),e.alive?1:0,e.hp|0])})`).then(JSON.parse);
    let prev = await sample(), moved = new Set();
    console.log('старт', JSON.stringify(prev));
    for (let s = 0; s < secs; s += 5) {
      await sleep(5000);
      const cur = await sample();
      for (const b of cur.bots) { const p = prev.bots.find(q => q[0] === b[0]); if (p && Math.hypot(b[1] - p[1], b[2] - p[2]) > 1) moved.add(b[0]); }
      console.log(`${s + 5}с: раунд ${cur.round} фаза ${cur.ph} счёт ${cur.score.CT}:${cur.score.T} живых ботов ${cur.bots.filter(b => b[3]).length}`);
      prev = cur;
    }
    console.log('двигались боты: ' + [...moved].sort().join(' ') + ' (' + moved.size + ')');
    await ev(`document.getElementById('hud')&&0`);
    await shot('play');
  }
  console.log(errors.length ? 'ОШИБКИ:\n' + errors.slice(0, 20).join('\n') : 'ошибок в консоли нет');
  ws.close(); chrome.kill();
  process.exit(0);
}
main().catch(e => { console.error('СБОЙ', e.message); if (chrome) chrome.kill(); process.exit(1); });
