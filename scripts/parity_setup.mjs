// 對拍:docs/scanner.js(本 repo,TWSE/TPEX 官方收盤)vs capital_stock_api static/setup.json(群益/XQ)。
// 兩邊判準同一套(setup_scan.mjs ↔ setup_scan.py),同一天的 flag/brk 名單應一致;
// 差異只該來自資料源(價格/量的小誤差、universe 不同造成 rank 邊界)。名單不一致 exit 1。
//   node scripts/parity_setup.mjs [path/to/setup.json]
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const capPath = process.argv[2] || join(ROOT, '..', 'capital_stock_api', 'static', 'setup.json');
const sg = JSON.parse(readFileSync(join(ROOT, 'docs', 'scanner.js'), 'utf8').replace(/^window\.SCANNER=/, '').replace(/;\s*$/, ''));
const cap = JSON.parse(readFileSync(capPath, 'utf8'));

if (sg.date !== cap.date) {
  console.error(`日期不同:scanner.js ${sg.date} vs setup.json ${cap.date},先讓兩邊跑到同一天`);
  process.exit(2);
}
console.log(`${sg.date}  候選池 sector_gainer ${sg.pool} / capital ${cap.pool}`);
let bad = 0;
for (const mode of ['flag', 'brk']) {
  const a = new Map(sg.stocks.filter(x => x[mode]).map(x => [x.id, x[mode]]));
  const b = new Map(cap[mode].map(x => [x.code, x]));
  const onlyA = [...a.keys()].filter(k => !b.has(k)), onlyB = [...b.keys()].filter(k => !a.has(k));
  const both = [...a.keys()].filter(k => b.has(k));
  console.log(`[${mode}] 共同 ${both.length}  只在 sector_gainer: ${onlyA.join(' ') || '-'}  只在 capital: ${onlyB.join(' ') || '-'}`);
  for (const k of both) {
    const d = ['pivot', 'stop', 'score'].map(f => Math.abs(a.get(k)[f] / b.get(k)[f] - 1));
    if (Math.max(...d) > 0.01) console.log(`  ${k} 數值差 >1%: pivot ${a.get(k).pivot}/${b.get(k).pivot} stop ${a.get(k).stop}/${b.get(k).stop} score ${a.get(k).score}/${b.get(k).score}`);
  }
  bad += onlyA.length + onlyB.length;
}
process.exit(bad ? 1 : 0);
