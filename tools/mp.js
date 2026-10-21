'use strict';
// Проверка сетевой игры: две вкладки Chrome без окна, хост создаёт комнату, гость входит по коду.
// node tools/mp.js <режим classic|dm|wing> [карта] [секунд]
const { spawn } = require('child_process');
const path = require('path'), os = require('os'), fs = require('fs');
const CHROME = process.env.CHROME || 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe';
const URL_ = process.env.GAME_URL || 'http://localhost:3999/?debug&menufps=2&drawfps=4';
// самый низкий приоритет: Windows отдаёт его (и запущенным отсюда Chrome) только свободный процессор, ПК не тормозит
try { os.setPriority(0, os.constants.priority.PRIORITY_LOWEST); } catch (e) { }
const OUT = path.join(__dirname, 'out', 'shots');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const [mode = 'dm', map = 'dust2', secs = '40'] = process.argv.slice(2);
let chromes = [];

async function page(port) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const wait = new Map(); const errors = [];
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    // net.js ловит исключения обработчиков и пишет их в console.error — их тоже считаем ошибками
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.description || a.value).join(' ')); };
  const cmd = (method, params = {}) => new Promise(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async x => { const r = await cmd('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval'); return r.result.result.value; };
  await cmd('Runtime.enable'); await cmd('Page.enable');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 640, height: 360, deviceScaleFactor: 1, mobile: false });
  await cmd('Page.navigate', { url: URL_ });
  for (let i = 0; i < 100 && !(await ev('!!window.__sf').catch(() => false)); i++) await sleep(200);
  const shot = async name => { const r = await cmd('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64')); };
  return { ev, shot, errors };
}
const until = async (p, expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await p.ev(expr).catch(() => false)) return true; await sleep(300); } return false; };
const REG = nick => `(()=>{if(!document.getElementById('regForm').hidden){document.getElementById('regNick').value=${JSON.stringify(nick)};document.getElementById('regBtn').click();}document.getElementById('tabNet').click();return 1})()`;
const STATE = `JSON.stringify({st:__sf.G.state,mode:__sf.G&&(document.getElementById('hud').classList.contains('dm')?'dm-hud':'')+'',score:__sf.G.score,round:__sf.G.round,me:__sf.G.human&&[__sf.G.human.id,__sf.G.human.team,__sf.G.human.alive],ents:__sf.G.ents.map(e=>e.id.slice(0,4)+(e.alive?'+':'-')+e.ctrl[0]).join(' ')})`;
// счёт на экране, в последнем принятом снимке хоста и в присутствии хоста прямо сейчас
const SYNC = `JSON.stringify({scr:__sf.G.score,last:__sf.NET.lastG&&__sf.NET.lastG.sc,pres:(p=>p&&p.presence.g&&p.presence.g.sc)(__sf.NET.room.peers().find(p=>p.peer===__sf.NET.hostPeer)),t:+__sf.G.time.toFixed(1)})`;
const HOSTS = `JSON.stringify({me:__sf.NET.me&&__sf.NET.me.slice(0,4),mode:__sf.NET.mode,claim:__sf.NET.claim,host:(__sf.NET.hostPeer||'').slice(0,4),peers:__sf.NET.room?__sf.NET.room.peers().map(p=>p.peer.slice(0,4)+':h'+p.presence.h+',inm'+p.presence.inm+',st'+p.presence.st+',since'+(p.presence.since%100000)):null})`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  // два отдельных Chrome с разными профилями: как два разных компьютера, обе вкладки на переднем плане
  const launch = async tag => { const port = 9300 + Math.floor(Math.random() * 500);
    chromes.push(spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + path.join(os.tmpdir(), 'sandfront-mp-' + tag),
      '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run', '--mute-audio', '--window-size=640,360', 'about:blank'], { stdio: 'ignore' }));
    for (let i = 0; i < 50; i++) { await sleep(200); try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch (e) { } }
    return page(port); };
  const A = await launch('a'), B = await launch('b');
  await A.ev(REG('Хост')); await B.ev(REG('Гость'));
  if (!await until(A, "!document.getElementById('createRoom').disabled", 90000) || !await until(B, "!document.getElementById('joinCode').disabled", 90000)) throw new Error('лобби не подключилось: A ' + await A.ev("document.getElementById('netStatus').textContent+' create:'+document.getElementById('createRoom').disabled+' reg:'+document.getElementById('regForm').hidden") + ' | B ' + await B.ev("document.getElementById('netStatus').textContent+' join:'+document.getElementById('joinCode').disabled+' sf:'+!!window.__sf+' claude:'+typeof window.claude+' ws:'+performance.getEntriesByType('resource').map(r=>r.name.split('/').pop()).join(',')") + ' errB=' + B.errors.join(';') + ' errA=' + A.errors.join(';'));
  await A.ev(`(__sf.settings.map=${JSON.stringify(map)},document.getElementById('createRoom').click(),1)`);
  if (!await until(A, "/^[a-z0-9]/.test(document.getElementById('roomCode').textContent)")) throw new Error('комната не создана');
  const code = await A.ev("document.getElementById('roomCode').textContent");
  await until(A, "!document.querySelector('#rMode button').disabled", 8000);
  await A.ev(`(document.querySelector('#rMode [data-v=${mode}]').click(),document.querySelector('#rMap [data-v=${map}]').click(),1)`);
  console.log('комната', code, 'режим', await A.ev("document.querySelector('#rMode [aria-pressed=true]')?.dataset.v"));
  await B.ev(`(document.getElementById('codeIn').value=${JSON.stringify(code)},document.getElementById('joinCode').click(),1)`);
  if (!await until(B, "!document.getElementById('roomv').hidden")) throw new Error('гость не вошёл в комнату');
  await sleep(2500);
  await A.ev("document.getElementById('roomStart').click()");
  if (!await until(B, "__sf.G.state==='playing'", 30000)) throw new Error('гость не вошёл в матч');
  console.log('матч начался; гость видит режим', await B.ev("document.querySelector('#rModeNote')?.textContent.slice(0,20)"));
  const half = (+secs) * 500;
  await sleep(half);
  console.log('A:', await A.ev(STATE)); console.log('B:', await B.ev(STATE)); console.log('A host:', await A.ev(HOSTS)); console.log('B host:', await B.ev(HOSTS));
  if (mode === 'dm') {
    // Chrome без видеокарты сильно тормозит, и между замерами в игре проходят секунды,
    // поэтому смерть проверяем сразу в том же вызове, а у хоста — по счётчику смертей
    const gid = JSON.stringify(await B.ev('__sf.G.human.id'));
    const hostGuest = `(()=>{const e=__sf.G.ents.find(x=>x.id===${gid});return e?[e.alive,e.deaths]:null})()`;
    const d0 = (await A.ev(hostGuest) || [0, 0])[1];
    console.log('гость убит:', await B.ev('(__sf.killMe(),!__sf.G.human.alive)'));
    console.log('хост засчитал смерть гостя:', await until(A, `(${hostGuest}||[0,0])[1]>${d0}`, 15000), d0, await A.ev(`JSON.stringify([${hostGuest},__sf.NET.peers.get(${gid})?.evSeen,[...__sf.NET.peers.keys()].map(k=>k.slice(0,4)),(()=>{const p=__sf.NET.room.peers().find(p=>p.peer===${gid});return p?[p.kind,p.sameTab,Object.keys(p.presence),JSON.stringify(p.presence.ev).slice(0,200),p.presence.st,p.presence.inm]:'нет в комнате'})(),__sf.G.state,__sf.NET.mode])`), await B.ev('JSON.stringify([__sf.NET.evSeq,__sf.NET.ev.map(e=>e.slice(0,4))])'));
    console.log('гость возродился:', await until(B, '__sf.G.human.alive', 15000));
    console.log('у хоста гость снова жив:', await until(A, `(${hostGuest}||[])[0]===true`, 15000));
  }
  await sleep(half);
  console.log('A:', await A.ev(STATE)); console.log('B:', await B.ev(STATE)); console.log('A host:', await A.ev(HOSTS)); console.log('B host:', await B.ev(HOSTS));
  for (let i = 0; i < 3; i++) { const [a, b] = await Promise.all([A.ev(SYNC), B.ev(SYNC)]); console.log('счёт хост', a, '| гость', b); await sleep(2000); }
  await A.shot('mp-host-' + mode); await B.shot('mp-guest-' + mode);
  console.log(A.errors.length || B.errors.length ? 'ОШИБКИ:\nA ' + A.errors.join('\nA ') + '\nB ' + B.errors.join('\nB ') : 'ошибок нет');
  for (const c of chromes) c.kill(); process.exit(0);
})().catch(e => { console.error('СБОЙ', e.message); for (const c of chromes) c.kill(); process.exit(1); });
