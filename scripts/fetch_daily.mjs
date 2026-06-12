// Fetch TWSE(上市) + TPEX(上櫃) daily close/turnover -> data/daily/YYYY-MM-DD.csv
// Usage:
//   node scripts/fetch_daily.mjs                  -> today (Asia/Taipei)
//   node scripts/fetch_daily.mjs 2026-06-11       -> specific date
//   node scripts/fetch_daily.mjs --backfill 370   -> past N calendar days (skips existing files)
import { writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'data', 'daily');
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0', 'Accept': 'application/json' };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = s => {
  const v = parseFloat(String(s).replace(/,/g, ''));
  return Number.isFinite(v) ? v : null;
};

function taipeiToday() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
}

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

// 上市:每日收盤行情(全部,不含權證)
async function fetchTwse(ymd) {
  const j = await fetchJson(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${ymd.replace(/-/g, '')}&type=ALLBUT0999&response=json`);
  if (j.stat !== 'OK' || !j.tables) return [];
  const t = j.tables.find(t => t.fields && t.fields[0] === '證券代號');
  if (!t) return [];
  const fi = Object.fromEntries(t.fields.map((f, i) => [f, i]));
  return t.data
    .filter(r => /^\d{4}$/.test(r[fi['證券代號']]))
    .map(r => {
      const close = num(r[fi['收盤價']]);
      const sign = /<p[^>]*>\s*\+/.test(r[fi['漲跌(+/-)']]) ? 1 : /<p[^>]*>\s*-/.test(r[fi['漲跌(+/-)']]) ? -1 : 0;
      const diff = num(r[fi['漲跌價差']]);
      return {
        id: r[fi['證券代號']],
        name: String(r[fi['證券名稱']]).trim(),
        market: 'TWSE',
        close,
        change: close == null || diff == null ? null : sign * diff,
        turnover: num(r[fi['成交金額']]) ?? 0,
        high: num(r[fi['最高價']]),
        low: num(r[fi['最低價']]),
      };
    })
    .filter(s => s.close != null);
}

// 上櫃:每日收盤行情
async function fetchTpex(ymd) {
  const j = await fetchJson(`https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=${ymd.replace(/-/g, '/')}&type=AL&response=json`);
  const t = (j.tables || []).find(t => t.fields && t.fields[0] === '代號' && (t.data || []).length);
  if (!t) return [];
  const fi = Object.fromEntries(t.fields.map((f, i) => [f, i]));
  const turnKey = t.fields.find(f => f.startsWith('成交金額'));
  return t.data
    .filter(r => /^\d{4}$/.test(r[fi['代號']]))
    .map(r => {
      const close = num(r[fi['收盤']]);
      return {
        id: r[fi['代號']],
        name: String(r[fi['名稱']]).trim(),
        market: 'TPEX',
        close,
        change: num(r[fi['漲跌']]),
        turnover: num(r[fi[turnKey]]) ?? 0,
        high: num(r[fi['最高']]),
        low: num(r[fi['最低']]),
      };
    })
    .filter(s => s.close != null);
}

async function fetchDay(date) {
  const file = join(OUT_DIR, `${date}.csv`);
  const [twse, tpex] = [await fetchTwse(date), await fetchTpex(date)];
  const rows = [...twse, ...tpex];
  if (rows.length < 100) return false; // 休市日
  // 單邊缺漏(被擋/暫時故障)寧可不寫,留給下次補抓,避免殘缺檔污染報酬鏈
  if (twse.length < 500 || tpex.length < 300) {
    process.stderr.write(`${date}: INCOMPLETE (TWSE ${twse.length} / TPEX ${tpex.length}) - not written\n`);
    return false;
  }
  const csv = ['id,name,market,close,change,turnover,high,low',
    ...rows.map(s => `${s.id},${s.name.replace(/,/g, '')},${s.market},${s.close},${s.change ?? ''},${s.turnover},${s.high ?? ''},${s.low ?? ''}`)].join('\n');
  writeFileSync(file, csv, 'utf8');
  process.stderr.write(`${date}: ${rows.length} rows (TWSE ${twse.length} / TPEX ${tpex.length})\n`);
  return true;
}

// 增補模式:只把 high/low 併入既有檔案,收盤價必須與舊檔一致(>=95% 吻合)才寫入。
// 不改動已驗證的 close/change/turnover,新到舊處理(ADR 只需近 20 日,先求近期可用)。
async function augmentDay(file) {
  const date = file.slice(0, 10);
  const path = join(OUT_DIR, file);
  const lines = readFileSync(path, 'utf8').split('\n');
  if (lines[0].includes('high')) return 'done';
  const [twse, tpex] = [await fetchTwse(date), await fetchTpex(date)];
  const map = new Map([...twse, ...tpex].map(s => [s.id, s]));
  let ok = 0, tot = 0;
  const out = [lines[0] + ',high,low'];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const parts = lines[i].split(',');
    const close = +parts[3];
    const n = map.get(parts[0]);
    tot++;
    if (n && Math.abs(n.close - close) <= close * 0.005) {
      ok++;
      out.push(lines[i] + ',' + (n.high ?? '') + ',' + (n.low ?? ''));
    } else out.push(lines[i] + ',,');
  }
  if (!tot || ok / tot < 0.95) {
    process.stderr.write(`${date}: AUGMENT SKIP (matched ${ok}/${tot})\n`);
    return 'skip';
  }
  writeFileSync(path, out.join('\n'), 'utf8');
  process.stderr.write(`${date}: augmented (${ok}/${tot})\n`);
  return 'ok';
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const args = process.argv.slice(2);

  if (args[0] === '--augment') {
    const files = readdirSync(OUT_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.csv$/.test(f)).sort().reverse();
    let skipped = 0;
    for (const f of files) {
      try {
        const r = await augmentDay(f);
        if (r === 'done') continue;
        if (r === 'skip') skipped++;
      } catch (e) {
        process.stderr.write(`${f}: ERROR ${e.message}\n`);
        skipped++;
      }
      await sleep(900);
    }
    process.stderr.write(`augment finished, skipped ${skipped}\n`);
    return;
  }

  if (args[0] === '--backfill') {
    const days = parseInt(args[1] || '370', 10);
    const force = args.includes('--force');
    const today = new Date(taipeiToday());
    for (let i = days; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86400e3);
      if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
      const date = d.toISOString().slice(0, 10);
      if (!force && existsSync(join(OUT_DIR, `${date}.csv`))) continue;
      try {
        await fetchDay(date);
      } catch (e) {
        process.stderr.write(`${date}: ERROR ${e.message}\n`);
      }
      await sleep(400);
    }
    return;
  }

  const date = /^\d{4}-\d{2}-\d{2}$/.test(args[0] || '') ? args[0] : taipeiToday();
  const ok = await fetchDay(date);
  if (!ok) process.stderr.write(`${date}: no data (market closed?)\n`);
}

main();
