// Build sector-weighted gain report from data/daily/*.csv + data/exrights.csv + data/categories.json
// -> docs/index.html (互動報表) + docs/report.json + README.md
//
// 漲幅計算:每日還原報酬鏈 ret[t] = close[t]/ref[t] - 1,
//   ref[t] = 除權息參考價(除權息日)或 close[t] - 漲跌價差(一般日)。
//   各時間尺度漲幅 = 鏈上累積指數比值,等同 XQ 的還原權息漲幅。
// 時間尺度(對齊 XQ):1w = -7 日曆天,1m/3m/6m/12m = 日曆月回推,取目標日(含)以前最近交易日。
// 類股加權:成份股當日成交金額占比(該尺度無資料者剔除後重新正規化)。
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAILY = join(ROOT, 'data', 'daily');
const PAGES_URL = 'https://user01ju.github.io/sector_gainer/';

// ---------- load ----------
const exrights = new Map();
if (existsSync(join(ROOT, 'data', 'exrights.csv'))) {
  for (const ln of readFileSync(join(ROOT, 'data', 'exrights.csv'), 'utf8').split('\n').slice(1)) {
    const [date, id, ref] = ln.split(',');
    if (date && id) exrights.set(`${date}|${id}`, +ref);
  }
}

const files = readdirSync(DAILY).filter(f => /^\d{4}-\d{2}-\d{2}\.csv$/.test(f)).sort();
if (!files.length) { console.error('no daily data'); process.exit(1); }
const dates = files.map(f => f.slice(0, 10));

function loadDay(f) {
  const map = new Map();
  for (const ln of readFileSync(join(DAILY, f), 'utf8').split('\n').slice(1)) {
    const [id, , , close, change, turnover] = ln.split(',');
    if (id) map.set(id, { close: +close, change: change === '' ? null : +change, turnover: +turnover });
  }
  return map;
}
const rawDays = files.map(loadDay);

// 毒日偵測:台股有 ±10% 漲跌幅限制,單日超過 5% 個股漲跌逾 ±12% = 交易所資料異常,整天剔除
const WILD = 1.12;
const dropped = new Array(files.length).fill(false);
{
  const lastClose = new Map();
  rawDays.forEach((day, i) => {
    let wild = 0, tot = 0;
    for (const [id, { close }] of day) {
      const pc = lastClose.get(id);
      if (pc) { tot++; const r = close / pc; if (r > WILD || r < 1 / WILD) wild++; }
    }
    if (tot >= 500 && wild / tot > 0.05) {
      dropped[i] = true;
      process.stderr.write(`WARNING: dropped anomalous day ${dates[i]} (${wild}/${tot} moves beyond limit)\n`);
      return;
    }
    for (const [id, { close }] of day) lastClose.set(id, close);
  });
}
let T = files.length - 1;
while (T >= 0 && dropped[T]) T--;
const latestDate = dates[T];

// 還原報酬鏈:ret[t] = close[t] / (除權息參考價 ?? 前一保留日收盤)。
// 連續收盤相除對單日錯價自動首尾相消;孤立的限制外跳動(股票分割/減資)視為價值中性。
const series = new Map(); // id -> { pos:[dayIdx], cum:[還原指數], last:{...} }
rawDays.forEach((day, i) => {
  if (dropped[i]) return;
  for (const [id, { close, change, turnover }] of day) {
    let s = series.get(id);
    if (!s) { s = { pos: [], cum: [], pc: null, lastIdx: null }; series.set(id, s); }
    const exref = exrights.get(`${dates[i]}|${id}`);
    const base = exref ?? s.pc;
    let ret = base != null && base > 0 ? close / base : 1;
    // 跨越剔除日/缺資料日最多允許 ±12% 複利兩次;再超出 = 未知資本事件(分割/減資),視為價值中性
    const gap = s.lastIdx == null ? 1 : Math.min(i - s.lastIdx, 2);
    const band = Math.pow(WILD, gap);
    if (ret > band || ret < 1 / band) ret = 1;
    s.cum.push((s.cum.length ? s.cum[s.cum.length - 1] : 1) * ret);
    s.pos.push(i);
    s.pc = close;
    s.lastIdx = i;
    if (i === T) s.last = { close, change, turnover, exref };
  }
});

// ---------- horizon base dates ----------
function minusMonths(iso, m) {
  let [y, mo, d] = iso.split('-').map(Number);
  mo -= m;
  while (mo < 1) { mo += 12; y--; }
  d = Math.min(d, new Date(Date.UTC(y, mo, 0)).getUTCDate());
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
const minusDays = (iso, n) => new Date(new Date(iso + 'T00:00:00Z').getTime() - n * 86400e3).toISOString().slice(0, 10);

const TARGETS = {
  w1: minusDays(latestDate, 7),
  m1: minusMonths(latestDate, 1),
  m3: minusMonths(latestDate, 3),
  m6: minusMonths(latestDate, 6),
  m12: minusMonths(latestDate, 12),
};
// 全市場層級的基準交易日(顯示用)
const baseDates = Object.fromEntries(Object.entries(TARGETS).map(([k, target]) => {
  let i = T; while (i >= 0 && dates[i] > target) i--;
  return [k, i >= 0 ? dates[i] : null];
}));
const baseIdx = Object.fromEntries(Object.entries(baseDates).map(([k, d]) => [k, d ? dates.indexOf(d) : -1]));

const METRICS = ['d', 'w1', 'm1', 'm3', 'm6', 'm12'];

function stockMetrics(id) {
  const s = series.get(id);
  if (!s || !s.last) return null;
  const { close, change, turnover, exref } = s.last;
  const m = { close, turnover };
  const ref = exref ?? (change != null ? close - change : close);
  m.d = ref > 0 ? (close / ref - 1) * 100 : null;
  const cumT = s.cum[s.cum.length - 1];
  for (const k of Object.keys(TARGETS)) {
    const bi = baseIdx[k];
    if (bi < 0) { m[k] = null; continue; }
    // 個股序列中 ≤ 基準日的最近一筆
    let lo = 0, hi = s.pos.length - 1, found = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (s.pos[mid] <= bi) { found = mid; lo = mid + 1; } else hi = mid - 1; }
    m[k] = found >= 0 ? (cumT / s.cum[found] - 1) * 100 : null;
  }
  return m;
}

// ---------- aggregate ----------
const categories = JSON.parse(readFileSync(join(ROOT, 'data', 'categories.json'), 'utf8'));

const sectors = categories.map(cat => {
  const stocks = cat.stocks
    .map(st => {
      const m = stockMetrics(st.id);
      return m ? { id: st.id, name: st.name, ...m } : null;
    })
    .filter(Boolean);

  const totalTurnover = stocks.reduce((s, x) => s + x.turnover, 0);
  for (const x of stocks) x.weight = totalTurnover ? x.turnover / totalTurnover : 0;
  stocks.sort((a, b) => b.weight - a.weight);

  const agg = {};
  for (const k of METRICS) {
    let wSum = 0, vSum = 0;
    for (const x of stocks) {
      if (x[k] == null) continue;
      wSum += x.weight;
      vSum += x.weight * x[k];
    }
    agg[k] = wSum > 0 ? vSum / wSum : null;
  }

  return {
    parent: cat.parent,
    name: cat.name,
    code: cat.code,
    count: stocks.length,
    turnover: totalTurnover,
    ...agg,
    stocks: stocks.map(x => ({
      id: x.id, name: x.name, close: x.close,
      weight: +(x.weight * 100).toFixed(2),
      turnover: x.turnover,
      ...Object.fromEntries(METRICS.map(k => [k, x[k] == null ? null : +x[k].toFixed(2)])),
    })),
  };
}).filter(s => s.count > 0);

for (const s of sectors) for (const k of METRICS) if (s[k] != null) s[k] = +s[k].toFixed(2);
sectors.sort((a, b) => (b.d ?? -999) - (a.d ?? -999));

const report = { date: latestDate, baseDates, sectors };
writeFileSync(join(ROOT, 'docs', 'report.json'), JSON.stringify(report), 'utf8');

// ---------- README.md ----------
const fmt = v => v == null ? '--' : v.toFixed(2);
const mdRows = sectors.map(s =>
  `| ${s.parent} | [${s.name}](https://www.cmoney.tw/forum/category/${s.code}) | ${s.count} | ${(s.turnover / 1e8).toFixed(1)} | ${fmt(s.d)} | ${fmt(s.w1)} | ${fmt(s.m1)} | ${fmt(s.m3)} | ${fmt(s.m6)} | ${fmt(s.m12)} |`
).join('\n');

writeFileSync(join(ROOT, 'README.md'), `# 台股類股漲幅報表

更新日期:**${latestDate}**(每個交易日自動更新)

👉 **[互動版報表](${PAGES_URL})** — 可排序、搜尋、展開成份股

- 子類股漲幅 = 成份股漲幅以**當日成交金額占比**加權
- 還原權息;1w = 7 日曆天前,1m/3m/6m/12m = 日曆月回推,取最近交易日
- 基準日:1w ${baseDates.w1} / 1m ${baseDates.m1} / 3m ${baseDates.m3} / 6m ${baseDates.m6} / 12m ${baseDates.m12}

| 大類 | 子類股 | 檔數 | 成交金額(億) | 當日% | 1w% | 1m% | 3m% | 6m% | 12m% |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
${mdRows}

> 資料來源:TWSE / TPEX 每日收盤行情與除權息參考價;類股分類:CMoney
`, 'utf8');

// ---------- docs/index.html ----------
const html = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>台股類股漲幅報表 ${latestDate}</title>
<style>
  :root { --up:#d6453d; --down:#1a9850; --bg:#fafafa; --line:#e5e5e5; }
  * { box-sizing:border-box; }
  body { font-family:"Segoe UI","Microsoft JhengHei",sans-serif; margin:0; background:var(--bg); color:#222; }
  header { padding:16px 24px 8px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:#777; font-size:12px; }
  .controls { display:flex; gap:8px; flex-wrap:wrap; padding:8px 24px; align-items:center; }
  .controls input, .controls select { padding:6px 10px; border:1px solid #ccc; border-radius:6px; font-size:13px; }
  .tbl-wrap { padding:0 24px 40px; overflow-x:auto; }
  table { border-collapse:collapse; width:100%; background:#fff; font-size:13px; box-shadow:0 1px 3px rgba(0,0,0,.08); }
  th, td { padding:7px 10px; border-bottom:1px solid var(--line); white-space:nowrap; }
  th { background:#f0f0f0; cursor:pointer; user-select:none; position:sticky; top:0; text-align:right; }
  th:nth-child(-n+3), td:nth-child(-n+3) { text-align:left; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; }
  tr.sector { cursor:pointer; }
  tr.sector:hover { background:#f5f9ff; }
  tr.stock { background:#fcfcfc; color:#444; font-size:12px; }
  tr.stock td:first-child { padding-left:28px; }
  .up { color:var(--up); } .down { color:var(--down); }
  .arrow { color:#999; font-size:10px; }
  .bar { display:inline-block; height:8px; background:#c8d9f0; border-radius:2px; margin-right:6px; vertical-align:middle; }
</style>
</head>
<body>
<header>
  <h1>台股類股漲幅報表</h1>
  <div class="sub">更新:${latestDate} ・ 當日成交金額占比加權 ・ 還原權息 ・ 基準日 1w:${baseDates.w1} / 1m:${baseDates.m1} / 3m:${baseDates.m3} / 6m:${baseDates.m6} / 12m:${baseDates.m12}</div>
</header>
<div class="controls">
  <select id="parentSel"><option value="">全部大類</option></select>
  <input id="search" placeholder="搜尋類股 / 個股代碼名稱" size="24">
  <span class="sub">點欄位標題排序,點類股列展開成份股</span>
</div>
<div class="tbl-wrap">
<table id="tbl">
  <thead><tr>
    <th data-k="parent">大類</th><th data-k="name">子類股</th><th data-k="count">檔數</th>
    <th data-k="turnover">成交金額(億)</th>
    <th data-k="d">當日%</th><th data-k="w1">1w%</th><th data-k="m1">1m%</th>
    <th data-k="m3">3m%</th><th data-k="m6">6m%</th><th data-k="m12">12m%</th>
  </tr></thead>
  <tbody></tbody>
</table>
</div>
<script>
const R = ${JSON.stringify(report)};
const METRICS = ['d','w1','m1','m3','m6','m12'];
let sortKey = 'd', sortDir = -1, expanded = new Set();

const fmt = v => v == null ? '--' : v.toFixed(2);
const cls = v => v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '';
const cell = v => '<td class="num ' + cls(v) + '">' + fmt(v) + '</td>';

function render() {
  const parent = document.getElementById('parentSel').value;
  const q = document.getElementById('search').value.trim().toLowerCase();
  let rows = R.sectors.filter(s => !parent || s.parent === parent);
  if (q) rows = rows.filter(s =>
    s.name.toLowerCase().includes(q) || s.parent.includes(q) ||
    s.stocks.some(x => x.id.includes(q) || x.name.toLowerCase().includes(q)));
  rows = rows.slice().sort((a, b) => {
    const va = a[sortKey], vb = b[sortKey];
    if (typeof va === 'string') return va.localeCompare(vb, 'zh-TW') * -sortDir;
    return ((vb ?? -9999) - (va ?? -9999)) * sortDir;
  });
  const tb = document.querySelector('#tbl tbody');
  tb.innerHTML = rows.map(s => {
    const key = s.parent + '|' + s.name;
    const open = expanded.has(key);
    let h = '<tr class="sector" data-key="' + key + '">' +
      '<td>' + s.parent + '</td>' +
      '<td><span class="arrow">' + (open ? '▼' : '▶') + '</span> ' + s.name + '</td>' +
      '<td class="num">' + s.count + '</td>' +
      '<td class="num">' + (s.turnover / 1e8).toFixed(1) + '</td>' +
      METRICS.map(k => cell(s[k])).join('') + '</tr>';
    if (open) {
      h += s.stocks.map(x =>
        '<tr class="stock"><td>' + x.id + ' ' + x.name + '</td>' +
        '<td><span class="bar" style="width:' + Math.min(100, x.weight * 2) + 'px"></span>' + x.weight.toFixed(1) + '%</td>' +
        '<td class="num">' + x.close + '</td>' +
        '<td class="num">' + (x.turnover / 1e8).toFixed(1) + '</td>' +
        METRICS.map(k => cell(x[k])).join('') + '</tr>').join('');
    }
    return h;
  }).join('');
}

document.querySelectorAll('#tbl th').forEach(th => th.onclick = () => {
  const k = th.dataset.k;
  if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = -1; }
  render();
});
document.querySelector('#tbl tbody').onclick = e => {
  const tr = e.target.closest('tr.sector');
  if (!tr) return;
  const k = tr.dataset.key;
  expanded.has(k) ? expanded.delete(k) : expanded.add(k);
  render();
};
[...new Set(R.sectors.map(s => s.parent))].forEach(p => {
  const o = document.createElement('option'); o.value = o.textContent = p;
  document.getElementById('parentSel').appendChild(o);
});
document.getElementById('parentSel').onchange = render;
document.getElementById('search').oninput = render;
render();
</script>
</body>
</html>`;
writeFileSync(join(ROOT, 'docs', 'index.html'), html, 'utf8');

console.error(`Report built for ${latestDate}: ${sectors.length} sectors -> docs/index.html, docs/report.json, README.md`);
