// Fetch 加權指數(TWSE FMTQIK,按月) + 櫃買指數(TPEX highlight,按日) -> data/market_index.csv
// Usage:
//   node scripts/fetch_index.mjs                 -> 本月(增量)
//   node scripts/fetch_index.mjs --backfill 380  -> 過去 N 天
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'market_index.csv');
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0', 'Accept': 'application/json' };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = s => {
  const v = parseFloat(String(s).replace(/,/g, ''));
  return Number.isFinite(v) ? v : null;
};
const taipeiToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const rocToIso = s => {
  const m = String(s).match(/^(\d{2,3})\/(\d{2})\/(\d{2})/);
  return m ? `${+m[1] + 1911}-${m[2]}-${m[3]}` : null;
};

async function fetchJson(url, retries = 2) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i >= retries) throw e;
      await sleep(1500 * (i + 1));
    }
  }
}

function load() {
  const map = new Map(); // date -> {taiex, otc}
  if (existsSync(OUT)) {
    for (const ln of readFileSync(OUT, 'utf8').split('\n').slice(1)) {
      const [date, taiex, otc] = ln.split(',');
      if (date) map.set(date, { taiex: taiex ? +taiex : null, otc: otc ? +otc : null });
    }
  }
  return map;
}

async function main() {
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  const args = process.argv.slice(2);
  const days = args[0] === '--backfill' ? parseInt(args[1] || '380', 10) : 35;
  const today = taipeiToday();
  const start = new Date(new Date(today).getTime() - days * 86400e3).toISOString().slice(0, 10);
  const map = load();
  const get = d => { if (!map.has(d)) map.set(d, { taiex: null, otc: null }); return map.get(d); };

  // TAIEX:FMTQIK 按月
  let cur = new Date(start.slice(0, 7) + '-01T00:00:00Z');
  const endD = new Date(today + 'T00:00:00Z');
  while (cur <= endD) {
    const ym = cur.toISOString().slice(0, 7).replace('-', '');
    try {
      const j = await fetchJson(`https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?date=${ym}01&response=json`);
      const fi = Object.fromEntries((j.fields || []).map((f, i) => [f, i]));
      let n = 0;
      for (const r of j.data || []) {
        const date = rocToIso(r[fi['日期']]);
        const v = num(r[fi['發行量加權股價指數']]);
        if (date && v) { get(date).taiex = v; n++; }
      }
      process.stderr.write(`TAIEX ${ym}: ${n} days\n`);
    } catch (e) {
      process.stderr.write(`TAIEX ${ym}: ERROR ${e.message}\n`);
    }
    cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    await sleep(400);
  }

  // 櫃買指數:highlight 按日(已有的略過)
  for (let d = new Date(start + 'T00:00:00Z'); d <= endD; d = new Date(d.getTime() + 86400e3)) {
    if ([0, 6].includes(d.getUTCDay())) continue;
    const date = d.toISOString().slice(0, 10);
    if (map.get(date)?.otc != null) continue;
    try {
      const j = await fetchJson(`https://www.tpex.org.tw/www/zh-tw/afterTrading/highlight?date=${date.replace(/-/g, '/')}&response=json`);
      const t = (j.tables || [])[0];
      if (t && t.data && t.data.length) {
        const fi = Object.fromEntries(t.fields.map((f, i) => [f, i]));
        const v = num(t.data[0][fi['收市指數']]);
        if (v) { get(date).otc = v; process.stderr.write(`OTC ${date}: ${v}\n`); }
      }
    } catch (e) {
      process.stderr.write(`OTC ${date}: ERROR ${e.message}\n`);
    }
    await sleep(350);
  }

  const rows = [...map.entries()]
    .filter(([, v]) => v.taiex != null || v.otc != null)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([d, v]) => `${d},${v.taiex ?? ''},${v.otc ?? ''}`);
  writeFileSync(OUT, ['date,taiex,otc', ...rows].join('\n'), 'utf8');
  process.stderr.write(`Saved ${rows.length} rows -> ${OUT}\n`);
}

main();
