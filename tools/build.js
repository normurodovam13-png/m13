'use strict';
// Собирает карты: проверяет проходимость, рисует планы в tools/out и пишет tools/out/maps.json.
// Запуск: node tools/build.js [имя_карты ...]
const fs = require('fs'), path = require('path');
const { validate, preview } = require('./lib');

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const all = fs.readdirSync(path.join(__dirname, 'maps')).filter(f => f.endsWith('.js')).map(f => f.slice(0, -3));
const only = process.argv.slice(2);
const jsonFile = path.join(OUT, 'maps.json');
let data = {};
try { data = JSON.parse(fs.readFileSync(jsonFile, 'utf8')); } catch (e) { }
let bad = false;
for (const id of all) {
  if (only.length && !only.includes(id)) continue;
  const m = require('./maps/' + id)();
  const v = validate(m);
  const ok = v.unreach === 0 && v.border === 0 && v.cnt.T >= 10 && v.cnt.S >= 10 && v.cnt.A > 30 && v.cnt.B > 30;
  if (!ok) bad = true;
  console.log(`${ok ? 'OK  ' : 'BAD '}${id}: проходимых ${v.walk}, недостижимых ${v.unreach}${v.lost.length ? ' (' + v.lost.join(' ') + ')' : ''}, граница ${v.border}, ` +
    `T ${v.cnt.T}/${v.miss.T}, CT ${v.cnt.S}/${v.miss.S}, A ${v.cnt.A}/${v.miss.A}, B ${v.cnt.B}/${v.miss.B}, декораций ${m.props.length}`);
  fs.writeFileSync(path.join(OUT, id + '.png'), preview(m, v));
  data[id] = m.export();
}
fs.writeFileSync(jsonFile, JSON.stringify(data));
console.log('maps.json: ' + Math.round(fs.statSync(jsonFile).size / 1024) + ' КБ');
process.exit(bad ? 1 : 0);
