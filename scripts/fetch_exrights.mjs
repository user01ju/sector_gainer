// Fetch 除權息參考價 (TWSE TWT49U + TPEX exDailyQ) -> data/exrights.csv (date,id,ref)
// 除權息日當天 TWSE/TPEX 收盤行情不提供漲跌價差,須用參考價才能算還原報酬。
// Usage:
//   node scripts/fetch_exrights.mjs                 -> today (Asia/Taipei)
//   node scripts/fetch_exrights.mjs --backfill 370  -> past N calendar days
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// 輸出路徑可用 EXRIGHTS_OUT 覆寫:capital_stock_api 的 screener 自己抓一份到它的 data/,
// 免得在本 repo 的工作區留下未 commit 的改動,害 update_report.bat 的 git pull --ff-only 掛掉。
const OUT = process.env.EXRIGHTS_OUT || join(ROOT, 'data', 'exrights.csv');
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0', 'Accept': 'application/json' };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = s => {
  const v = parseFloat(String(s).replace(/,/g, ''));
  return Number.isFinite(v) ? v : null;
};
const taipeiToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const rocToIso = s => {
  const m = String(s).match(/^(\d{2,3})[年/](\d{2})[月/](\d{2})/);
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

// TWSE 三種特殊日參考價表 + TPEX 減資表,皆支援日期區間,按月查
// 除權息 TWT49U、減資恢復買賣 TWTAUU、變更面額恢復買賣 TWTB8U(如國巨 1拆4)、TPEX 減資 revivt
const RANGE_SOURCES = [
  { tag: 'TWSE除權息', url: (s, e) => `https://www.twse.com.tw/rwd/zh/exRight/TWT49U?startDate=${s}&endDate=${e}&response=json`, dateF: '資料日期', idF: '股票代號', refF: '除權息參考價' },
  { tag: 'TWSE減資', url: (s, e) => `https://www.twse.com.tw/rwd/zh/reducation/TWTAUU?startDate=${s}&endDate=${e}&response=json`, dateF: '恢復買賣日期', idF: '股票代號', refF: '恢復買賣參考價' },
  { tag: 'TWSE面額變更', url: (s, e) => `https://www.twse.com.tw/rwd/zh/change/TWTB8U?startDate=${s}&endDate=${e}&response=json`, dateF: '恢復買賣日期', idF: '股票代號', refF: '恢復買賣參考價' },
  { tag: 'TPEX減資', url: (s, e) => `https://www.tpex.org.tw/www/zh-tw/bulletin/revivt?startDate=${s.slice(0, 4)}/${s.slice(4, 6)}/${s.slice(6)}&endDate=${e.slice(0, 4)}/${e.slice(4, 6)}/${e.slice(6)}&response=json`, dateF: '恢復買賣日期', idF: '股票代號', refF: '減資恢復買賣開始日參考價格' },
];

async function fetchRangeSources(start, end) {
  const rows = [];
  for (const src of RANGE_SOURCES) {
    let cur = new Date(start + 'T00:00:00Z');
    const endD = new Date(end + 'T00:00:00Z');
    while (cur <= endD) {
      const mEnd = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 0));
      const s = cur.toISOString().slice(0, 10).replace(/-/g, '');
      const e = (mEnd < endD ? mEnd : endD).toISOString().slice(0, 10).replace(/-/g, '');
      try {
        const j = await fetchJson(src.url(s, e));
        const tbl = j.tables ? (j.tables[0] || {}) : j;
        const fi = Object.fromEntries((tbl.fields || []).map((f, i) => [f, i]));
        let n = 0;
        for (const r of tbl.data || []) {
          const date = rocToIso(r[fi[src.dateF]]);
          const id = String(r[fi[src.idF]]).trim();
          const ref = num(r[fi[src.refF]]);
          if (date && /^\d{4}$/.test(id) && ref) { rows.push([date, id, ref]); n++; }
        }
        if (n) process.stderr.write(`${src.tag} ${s}-${e}: ${n} rows\n`);
      } catch (err) {
        process.stderr.write(`${src.tag} ${s}-${e}: ERROR ${err.message}\n`);
      }
      cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
      await sleep(400);
    }
  }
  return rows;
}

// TPEX:單日查詢(區間查詢疑似有 100 筆上限)
async function fetchTpexDay(date) {
  const j = await fetchJson(`https://www.tpex.org.tw/www/zh-tw/bulletin/exDailyQ?startDate=${date.replace(/-/g, '/')}&endDate=${date.replace(/-/g, '/')}&response=json`);
  const t = (j.tables || [])[0];
  if (!t || !t.data) return [];
  const fi = Object.fromEntries(t.fields.map((f, i) => [f, i]));
  return t.data
    .map(r => {
      const date2 = rocToIso(r[fi['除權息日期']]);
      const id = String(r[fi['代號']]).trim();
      const ref = num(r[fi['除權息參考價']]);
      return date2 && /^\d{4}$/.test(id) && ref ? [date2, id, ref] : null;
    })
    .filter(Boolean);
}

function loadExisting() {
  const map = new Map();
  if (existsSync(OUT)) {
    for (const ln of readFileSync(OUT, 'utf8').split('\n').slice(1)) {
      const [date, id, ref] = ln.split(',');
      if (date && id) map.set(`${date}|${id}`, +ref);
    }
  }
  return map;
}

function save(map) {
  const rows = [...map.entries()]
    .map(([k, ref]) => { const [date, id] = k.split('|'); return [date, id, ref]; })
    .sort((a, b) => a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0]));
  writeFileSync(OUT, ['date,id,ref', ...rows.map(r => r.join(','))].join('\n'), 'utf8');
  process.stderr.write(`Saved ${rows.length} ex-rights rows -> ${OUT}\n`);
}

async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  const args = process.argv.slice(2);
  const days = args[0] === '--backfill' ? parseInt(args[1] || '370', 10) : 0;
  const today = taipeiToday();
  const start = new Date(new Date(today).getTime() - days * 86400e3).toISOString().slice(0, 10);

  const map = loadExisting();
  for (const [date, id, ref] of await fetchRangeSources(start, today)) map.set(`${date}|${id}`, ref);

  let cur = new Date(start + 'T00:00:00Z');
  const endD = new Date(today + 'T00:00:00Z');
  while (cur <= endD) {
    const date = cur.toISOString().slice(0, 10);
    cur = new Date(cur.getTime() + 86400e3);
    if ([0, 6].includes(new Date(date + 'T00:00:00Z').getUTCDay())) continue;
    try {
      const rows = await fetchTpexDay(date);
      for (const [d, id, ref] of rows) map.set(`${d}|${id}`, ref);
      if (rows.length) process.stderr.write(`TPEX ${date}: ${rows.length}\n`);
    } catch (e) {
      process.stderr.write(`TPEX ${date}: ERROR ${e.message}\n`);
    }
    await sleep(350);
  }

  save(map);
}

main();
