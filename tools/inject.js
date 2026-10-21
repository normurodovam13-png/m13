'use strict';
// Вставляет tools/out/maps.json в игру (строка `const MAPS_RAW=...;`).
// Запуск: node tools/inject.js [файл.html ...]  (по умолчанию public/index.html)
const fs = require('fs'), path = require('path');
const data = fs.readFileSync(path.join(__dirname, 'out', 'maps.json'), 'utf8');
const files = process.argv.slice(2);
if (!files.length) files.push(path.join(__dirname, '..', 'public', 'index.html'));
for (const f of files) {
  let s = fs.readFileSync(f, 'utf8');
  const a = s.indexOf('const MAPS_RAW=');
  if (a < 0) throw new Error('нет MAPS_RAW в ' + f);
  const b = s.indexOf('\n', a);
  s = s.slice(0, a) + 'const MAPS_RAW=' + data + ';' + s.slice(b);
  fs.writeFileSync(f, s);
  console.log('карты вставлены в ' + f + ' (' + Math.round(data.length / 1024) + ' КБ)');
}
