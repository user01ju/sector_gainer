// Scrape MoneyDJ 產業/細產業/成分股 -> data/moneydj.json
//
// 用途:CMoney 的 87 子類股是單一歸屬、粒度粗(中位數 12 檔),缺 AI 伺服器/低軌衛星/
// 重電/儲能/光通訊 這類題材;MoneyDJ 有 1062 個細產業、多重歸屬(平均一檔屬 3.5 類),
// 拿來當「題材標籤 + 題材熱度榜」的來源。不取代 CMoney —— 多重歸屬會破壞成交金額
// 加權漲幅(鴻海一檔同時進 32 類,那 32 類會被同一檔帶著走)。
//
// ⚠️ 兩邊的分類代碼「撞號但不同義」:CMoney C23010=IC-設計,MoneyDJ C023010=中小尺吋面板。
//    61/87 個代碼補前導 0 後會命中 MoneyDJ,但只有 3 個名稱相同。join 只能用 stock id。
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Referer': 'https://www.moneydj.com/z/zh/zha/zh00.djhtm' };
const dec = new TextDecoder('big5');   // 站台是 Big5,不是 UTF-8
const CONC = 4, GAP = 120;

async function getBig5(url, attempt = 0) {
  try {
    const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return dec.decode(new Uint8Array(await r.arrayBuffer()));
  } catch (e) {
    if (attempt < 2) { await new Promise(r => setTimeout(r, 800 * (attempt + 1))); return getBig5(url, attempt + 1); }
    throw e;
  }
}

// 整棵產業樹在一支 JS 檔裡,不用爬:'C9110000 水泥類~C011010 水泥,C011011 水泥製品;...'
async function fetchTree() {
  const js = await getBig5('https://www.moneydj.com/z/js/IndustryListNewJS.djjs');
  const m = js.match(/var NewkindIDNameStr = '([\s\S]*?)';/);
  if (!m) throw new Error('產業樹格式改了:找不到 NewkindIDNameStr');
  const subs = [];
  for (const grp of m[1].split(';').filter(Boolean)) {
    const [head, rest] = grp.split('~');
    const [gid, ...gn] = head.trim().split(' ');
    for (const item of (rest || '').split(',').filter(Boolean)) {
      const [id, ...n] = item.trim().split(' ');
      subs.push({ id, name: n.join(' '), gid, gname: gn.join(' ') });
    }
  }
  return subs;
}

const RE_STK = /Link2Stk\('[A-Z]{2}([0-9A-Z]+)'\);">/g;

async function main() {
  const subs = await fetchTree();
  process.stderr.write(`產業樹:${new Set(subs.map(s => s.gid)).size} 大類 / ${subs.length} 細產業\n`);
  if (subs.length < 500) throw new Error(`細產業只解出 ${subs.length} 個,疑似改版 - 不寫檔`);

  const out = [];
  let done = 0, fail = 0;
  const queue = subs.slice();
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (queue.length) {
      const s = queue.shift();
      try {
        const html = await getBig5(`https://www.moneydj.com/z/zh/zha/zh00.djhtm?a=${s.id}`);
        out.push({ ...s, stocks: [...new Set([...html.matchAll(RE_STK)].map(m => m[1]))] });
      } catch (e) {
        fail++;
        out.push({ ...s, stocks: [], error: String(e.message || e) });
      }
      if (++done % 200 === 0) process.stderr.write(`  ${done}/${subs.length} (fail ${fail})\n`);
      await new Promise(r => setTimeout(r, GAP));
    }
  }));
  out.sort((a, b) => a.id.localeCompare(b.id));

  const total = out.reduce((s, x) => s + x.stocks.length, 0);
  const uniq = new Set(out.flatMap(x => x.stocks)).size;
  if (fail > subs.length * 0.05) throw new Error(`失敗 ${fail}/${subs.length} 筆(>5%) - 不寫檔`);
  if (!total) throw new Error('一檔成分股都沒抓到 - 不寫檔');

  // 部分改版防呆(比照 scrape_categories.mjs):跟現有檔比,總筆數掉 >15% 或原本非空的分類變空就中止
  const dest = join(ROOT, 'data', 'moneydj.json');
  if (existsSync(dest)) {
    const prev = JSON.parse(readFileSync(dest, 'utf8'));
    const prevTotal = prev.subs.reduce((s, x) => s + x.stocks.length, 0);
    const prevNonEmpty = new Set(prev.subs.filter(x => x.stocks.length).map(x => x.id));
    const wentEmpty = out.filter(x => !x.stocks.length && prevNonEmpty.has(x.id));
    if (total < prevTotal * 0.85 || wentEmpty.length) {
      throw new Error(`SANITY FAIL: 成分股 ${total} 筆(前次 ${prevTotal}),變空的分類:${wentEmpty.map(x => x.name).join(',') || '無'} - 不寫檔`);
    }
  }

  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(dest, JSON.stringify({
    updated: new Date().toISOString().slice(0, 10),
    subs: out.map(({ id, name, gid, gname, stocks }) => ({ id, name, gid, gname, stocks })),
  }), 'utf8');
  process.stderr.write(`Done: ${out.length} 細產業(${out.filter(x => !x.stocks.length).length} 空),${total} 筆成分股,${uniq} 檔不重複\nSaved -> ${dest}\n`);
}

main().catch(e => { process.stderr.write('ERROR: ' + e.message + '\n'); process.exit(1); });
