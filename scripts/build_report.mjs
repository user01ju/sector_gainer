// Build sector-weighted gain report from data/daily/*.csv + data/exrights.csv + data/categories.json
// -> docs/data.js + docs/report.json + README.md(docs/index.html 為靜態互動頁,讀 data.js)
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
    const [id, , , close, change, turnover, high, low] = ln.split(',');
    if (id) map.set(id, {
      close: +close, change: change === '' ? null : +change, turnover: +turnover,
      high: high ? +high : null, low: low ? +low : null,
    });
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
  for (const [id, { close, change, turnover, high, low }] of day) {
    let s = series.get(id);
    if (!s) { s = { pos: [], cum: [], hl: [], to: [], pc: null, lastIdx: null }; series.set(id, s); }
    s.hl.push(high != null && low != null && low > 0 ? high / low - 1 : null);
    s.to.push(turnover);
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

// 排除創新板(-創 / -KY創):漲跌幅與流動性制度不同、投機性高,單檔妖股會用爆量搶到高
// 成交金額權重、再乘以天文數字漲幅,污染整個類股(如 7610 聯友金屬-創曾把鋼鐵 6m 帶到 +604%)。
const INNOVATION = /(-創|KY創)$/;
for (const c of categories) c.stocks = c.stocks.filter(s => !INNOVATION.test(s.name));

// 個股還原指數在 idx(含)以前最近一筆
function cumAt(id, idx) {
  const s = series.get(id);
  if (!s) return null;
  let lo = 0, hi = s.pos.length - 1, found = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (s.pos[mid] <= idx) { found = mid; lo = mid + 1; } else hi = mid - 1; }
  return found >= 0 ? s.cum[found] : null;
}

// sparkline 取樣點:12 個月窗口內的保留日,均勻取最多 60 點
const sparkSamples = (() => {
  const start = baseIdx.m12 >= 0 ? baseIdx.m12 : 0;
  const kept = [];
  for (let i = start; i <= T; i++) if (!dropped[i]) kept.push(i);
  if (kept.length <= 60) return kept;
  return Array.from({ length: 60 }, (_, j) => kept[Math.round(j * (kept.length - 1) / 59)]);
})();

// 類股加權還原指數序列(% 相對窗口起點),加權方式與報表一致
function sparkOf(stocks) {
  const members = stocks
    .map(x => ({ w: x.weight, id: x.id, base: cumAt(x.id, sparkSamples[0]) }))
    .filter(x => x.base != null && x.w > 0);
  if (!members.length) return [];
  return sparkSamples.map(idx => {
    let num = 0, den = 0;
    for (const x of members) {
      const c = cumAt(x.id, idx);
      if (c == null) continue;
      num += x.w * (c / x.base);
      den += x.w;
    }
    return den > 0 ? +((num / den - 1) * 100).toFixed(1) : null;
  });
}

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
    spark: sparkOf(stocks),
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

// ---------- 大盤指數與紅綠燈 ----------
let market = null;
const idxFile = join(ROOT, 'data', 'market_index.csv');
if (existsSync(idxFile)) {
  const rows = readFileSync(idxFile, 'utf8').split('\n').slice(1)
    .map(l => l.split(','))
    .filter(r => r[0] && r[0] <= latestDate)
    .map(r => ({ date: r[0], taiex: r[1] ? +r[1] : null, otc: r[2] ? +r[2] : null }));
  const idxSeries = key => {
    const pts = rows.filter(r => r[key] != null);
    if (pts.length < 21) return null;
    const vals = pts.map(p => p[key]);
    const maN = n => vals.map((_, i) => i + 1 >= n ? +(vals.slice(i + 1 - n, i + 1).reduce((a, b) => a + b, 0) / n).toFixed(2) : null);
    const ma10 = maN(10), ma20 = maN(20);
    const c = vals[vals.length - 1], m10 = ma10[ma10.length - 1], m20 = ma20[ma20.length - 1];
    const light = c > m10 && c > m20 ? 'green' : c < m10 && c < m20 ? 'red' : 'yellow';
    const cut = Math.max(0, vals.length - 250);
    return { dates: pts.slice(cut).map(p => p.date), close: vals.slice(cut), ma10: ma10.slice(cut), ma20: ma20.slice(cut), light };
  };
  const taiex = idxSeries('taiex'), otc = idxSeries('otc');
  if (taiex || otc) market = { taiex, otc };
}

// ---------- 市場廣度:收盤 > 20MA 比例、52w 淨新高(還原序列,上市滿半年才計新高低) ----------
const keptOrd = new Array(files.length).fill(-1);
{ let o = 0; for (let i = 0; i < files.length; i++) if (!dropped[i]) keptOrd[i] = o++; }
const keptDates = dates.filter((_, i) => !dropped[i]);
const nK = keptDates.length;
const bAbove = new Array(nK).fill(0), bDenom = new Array(nK).fill(0);
const bNh = new Array(nK).fill(0), bNl = new Array(nK).fill(0);
const memberIds = new Set();
for (const c of categories) for (const st of c.stocks) memberIds.add(st.id);
for (const [id, s] of series) {
  if (!memberIds.has(id)) continue;
  const cum = s.cum, pos = s.pos;
  let sum20 = 0;
  for (let j = 0; j < cum.length; j++) {
    const ord = keptOrd[pos[j]];
    sum20 += cum[j];
    if (j >= 20) sum20 -= cum[j - 20];
    if (j >= 19) { bDenom[ord]++; if (cum[j] > sum20 / 20) bAbove[ord]++; }
    if (j >= 126) {
      let mx = -Infinity, mn = Infinity;
      for (let k = Math.max(0, j - 251); k <= j; k++) { const v = cum[k]; if (v > mx) mx = v; if (v < mn) mn = v; }
      if (cum[j] >= mx) bNh[ord]++; else if (cum[j] <= mn) bNl[ord]++;
    }
  }
}
const bCut = Math.max(0, nK - 250);
const lastK = nK - 1;
const breadth = {
  dates: keptDates.slice(bCut),
  above20: bAbove.slice(bCut).map((v, i) => bDenom[bCut + i] ? +(v / bDenom[bCut + i] * 100).toFixed(1) : null),
  net: bNh.slice(bCut).map((v, i) => v - bNl[bCut + i]),
  lastAbove: bAbove[lastK], lastDenom: bDenom[lastK], lastNh: bNh[lastK], lastNl: bNl[lastK],
};

const report = { date: latestDate, baseDates, market, breadth, sectors };
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

// ---------- docs/data.js(靜態頁 docs/index.html 以 <script src=data.js> 載入,file:// 也可用) ----------
writeFileSync(join(ROOT, 'docs', 'data.js'), 'window.REPORT=' + JSON.stringify(report) + ';', 'utf8');

// ---------- docs/scanner.js(Qullamaggie 式掃描指標,個股層級) ----------
const stockNames = new Map(), stockSectors = new Map();
for (const cat of categories) for (const st of cat.stocks) {
  stockNames.set(st.id, st.name);
  if (!stockSectors.has(st.id)) stockSectors.set(st.id, []);
  stockSectors.get(st.id).push(cat.name);
}
const start12 = baseIdx.m12 >= 0 ? baseIdx.m12 : 0;
const scanStocks = [];
for (const [id, s] of series) {
  if (!s.last || !stockSectors.has(id)) continue;
  const m = stockMetrics(id);
  if (!m) continue;
  const cumT = s.cum[s.cum.length - 1];
  // ADR20:近 20 日平均 (最高/最低 - 1),Qullamaggie 定義
  const hl = s.hl.filter(v => v != null).slice(-20);
  const adr = hl.length >= 10 ? +(hl.reduce((a, b) => a + b, 0) / hl.length * 100).toFixed(2) : null;
  // 距 52 週(資料窗口)還原高點
  let maxCum = 0;
  for (let j = s.pos.length - 1; j >= 0 && s.pos[j] >= start12; j--) if (s.cum[j] > maxCum) maxCum = s.cum[j];
  const off = maxCum > 0 ? +((cumT / maxCum - 1) * 100).toFixed(1) : null;
  // 還原序列對 MA 的距離
  const maDist = n => {
    if (s.cum.length < n) return null;
    let sum = 0;
    for (let j = s.cum.length - n; j < s.cum.length; j++) sum += s.cum[j];
    return +((cumT / (sum / n) - 1) * 100).toFixed(1);
  };
  // 10 日收縮度:近 10 日還原高低區間 %
  let tight = null;
  if (s.cum.length >= 10) {
    const w = s.cum.slice(-10);
    tight = +((Math.max(...w) / Math.min(...w) - 1) * 100).toFixed(1);
  }
  // 量縮比:近 5 日均量 / 近 20 日均量(< 1 = 整理期量縮)
  let vq = null;
  if (s.to.length >= 20) {
    const last20 = s.to.slice(-20);
    const m20 = last20.reduce((a, b) => a + b, 0) / 20;
    const m5 = last20.slice(-5).reduce((a, b) => a + b, 0) / 5;
    vq = m20 > 0 ? +(m5 / m20).toFixed(2) : null;
  }
  // 距近 10 日還原高(樞紐價距離代理,0 = 一觸即發)
  let p10 = null;
  if (s.cum.length >= 2) {
    const w = s.cum.slice(-10);
    p10 = +((cumT / Math.max(...w) - 1) * 100).toFixed(1);
  }
  // 動能預篩通過者才帶 sparkline,控制檔案大小
  let spark = [];
  if ((m.m1 != null && m.m1 >= 15) || (m.m3 != null && m.m3 >= 30)) {
    let base = null;
    spark = sparkSamples.map(idx => {
      const c = cumAt(id, idx);
      if (c == null) return null;
      if (base == null) base = c;
      return +((c / base - 1) * 100).toFixed(1);
    });
  }
  scanStocks.push({
    id, name: stockNames.get(id), sec: stockSectors.get(id).slice(0, 2).join('・'),
    close: m.close, turnover: m.turnover,
    adr, off, ma10: maDist(10), ma20: maDist(20), ma50: maDist(50), tight, vq, p10,
    ...Object.fromEntries(METRICS.map(k => [k, m[k] == null ? null : +m[k].toFixed(2)])),
    spark,
  });
}
writeFileSync(join(ROOT, 'docs', 'scanner.js'),
  'window.SCANNER=' + JSON.stringify({ date: latestDate, stocks: scanStocks }) + ';', 'utf8');

console.error(`Report built for ${latestDate}: ${sectors.length} sectors, ${scanStocks.length} scan stocks -> docs/data.js, docs/scanner.js, docs/report.json, README.md`);
