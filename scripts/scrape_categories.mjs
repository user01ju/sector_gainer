// Scrape CMoney forum categories -> data/categories.json
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { runInNewContext } from 'vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const BASE = 'https://www.cmoney.tw';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
  'Accept-Language': 'zh-TW,zh;q=0.9',
  'Accept': 'text/html,application/xhtml+xml',
};

const CATEGORIES = [
  // 傳產
  { parent: '傳產', name: '水泥',      code: 'C11010' },
  { parent: '傳產', name: '食品',      code: 'C12010' },
  { parent: '傳產', name: '塑膠',      code: 'C13010' },
  { parent: '傳產', name: '紡織纖維',  code: 'C14010' },
  { parent: '傳產', name: '電機',      code: 'C15010' },
  { parent: '傳產', name: '電線電纜',  code: 'C16010' },
  { parent: '傳產', name: '化學工業',  code: 'C17010' },
  { parent: '傳產', name: '生技',      code: 'C17020' },
  { parent: '傳產', name: '玻璃陶瓷',  code: 'C18010' },
  { parent: '傳產', name: '紙業',      code: 'C19010' },
  { parent: '傳產', name: '鋼鐵',      code: 'C20010' },
  { parent: '傳產', name: '橡膠',      code: 'C21010' },
  { parent: '傳產', name: '汽車',      code: 'C22010' },
  { parent: '傳產', name: '汽車零組件',code: 'C22020' },
  { parent: '傳產', name: '營建',      code: 'C25010' },
  { parent: '傳產', name: '航運',      code: 'C26010' },
  { parent: '傳產', name: '觀光',      code: 'C27010' },
  { parent: '傳產', name: '百貨',      code: 'C29010' },
  { parent: '傳產', name: '其他',      code: 'C29020' },
  { parent: '傳產', name: '自行車',    code: 'C29030' },
  { parent: '傳產', name: '高爾夫球',  code: 'C30010' },
  { parent: '傳產', name: '運動休閒',  code: 'C30011' },
  { parent: '傳產', name: '文創娛樂',  code: 'C30012' },
  { parent: '傳產', name: '綠能環保',  code: 'C30013' },
  { parent: '傳產', name: '照明',      code: 'C30014' },
  // 電子上游
  { parent: '電子上游', name: 'IC-設計',       code: 'C23010' },
  { parent: '電子上游', name: 'IC-代工',       code: 'C23020' },
  { parent: '電子上游', name: 'IC-DRAM製造',   code: 'C23030' },
  { parent: '電子上游', name: 'DRAM銷售',      code: 'C23040' },
  { parent: '電子上游', name: 'IC-製造',       code: 'C23050' },
  { parent: '電子上游', name: 'IC-封測',       code: 'C23060' },
  { parent: '電子上游', name: 'IC-通路',       code: 'C23070' },
  { parent: '電子上游', name: 'IC-其他',       code: 'C23080' },
  { parent: '電子上游', name: '被動元件',      code: 'C23090' },
  { parent: '電子上游', name: 'LED及光元件',   code: 'C23100' },
  { parent: '電子上游', name: '連接元件',      code: 'C23110' },
  { parent: '電子上游', name: 'PCB-製造',      code: 'C23120' },
  { parent: '電子上游', name: 'PCB-材料設備',  code: 'C23130' },
  { parent: '電子上游', name: 'IC-半導體設備', code: 'C30015' },
  { parent: '電子上游', name: '晶圓材料',      code: 'C30016' },
  { parent: '電子上游', name: '半導體元件',    code: 'C30017' },
  { parent: '電子上游', name: '記憶體IC設計',  code: 'C30018' },
  { parent: '電子上游', name: 'IP/ASIC',       code: 'C30019' },
  { parent: '電子上游', name: 'IC-導線架',     code: 'C30020' },
  { parent: '電子上游', name: 'ABF',           code: 'C30021' },
  // 電子中游
  { parent: '電子中游', name: 'LCD-TFT面板',   code: 'C23140' },
  { parent: '電子中游', name: 'LCD-零組件',    code: 'C23150' },
  { parent: '電子中游', name: 'LCD-STN面板',   code: 'C23160' },
  { parent: '電子中游', name: '電源供應器',    code: 'C23170' },
  { parent: '電子中游', name: '變壓器與UPS',   code: 'C23180' },
  { parent: '電子中游', name: '主機板',        code: 'C23190' },
  { parent: '電子中游', name: '光學鏡片',      code: 'C23200' },
  { parent: '電子中游', name: 'NB與手機零組件',code: 'C23210' },
  { parent: '電子中游', name: 'PC介面卡',      code: 'C23220' },
  { parent: '電子中游', name: '機殼',          code: 'C23230' },
  { parent: '電子中游', name: '儀器設備工程',  code: 'C23240' },
  { parent: '電子中游', name: '通訊設備',      code: 'C23250' },
  { parent: '電子中游', name: '網通',          code: 'C23260' },
  { parent: '電子中游', name: 'EMS',           code: 'C23270' },
  { parent: '電子中游', name: '其他',          code: 'C23280' },
  { parent: '電子中游', name: '磁碟陣列',      code: 'C30022' },
  { parent: '電子中游', name: '二次電池',      code: 'C30023' },
  { parent: '電子中游', name: '散熱零組件',    code: 'C30024' },
  { parent: '電子中游', name: '聲學元件',      code: 'C30025' },
  { parent: '電子中游', name: '金屬製品',      code: 'C30026' },
  { parent: '電子中游', name: '電子元件通路',  code: 'C30027' },
  // 電子下游
  { parent: '電子下游', name: '數位相機',      code: 'C23290' },
  { parent: '電子下游', name: '顯示器',        code: 'C23310' },
  { parent: '電子下游', name: '電信服務',      code: 'C23320' },
  { parent: '電子下游', name: '工業電腦',      code: 'C23330' },
  { parent: '電子下游', name: '資訊通路',      code: 'C23350' },
  { parent: '電子下游', name: '掃描器',        code: 'C23360' },
  { parent: '電子下游', name: '安全監控',      code: 'C23370' },
  { parent: '電子下游', name: '筆記型電腦',    code: 'C23380' },
  { parent: '電子下游', name: '消費電子',      code: 'C23390' },
  { parent: '電子下游', name: '商業自動化',    code: 'C23400' },
  { parent: '電子下游', name: '手機製造',      code: 'C23410' },
  { parent: '電子下游', name: '太陽能',        code: 'C23415' },
  { parent: '電子下游', name: '其他',          code: 'C23420' },
  { parent: '電子下游', name: '電腦周邊',      code: 'C30028' },
  // 軟體
  { parent: '軟體', name: '系統整合', code: 'C23430' },
  { parent: '軟體', name: '遊戲',     code: 'C23440' },
  { parent: '軟體', name: '其他',     code: 'C23450' },
  // 金融
  { parent: '金融', name: '金控', code: 'C28010' },
  { parent: '金融', name: '銀行', code: 'C28020' },
  { parent: '金融', name: '證券', code: 'C28030' },
  { parent: '金融', name: '保險', code: 'C28040' },
];

async function fetchStocks(code) {
  try {
    const res = await fetch(`${BASE}/forum/category/${code}`, { headers: HEADERS });
    const html = await res.text();
    const m = html.match(/__NUXT__=(\(function[\s\S]*?)<\/script>/);
    if (!m) return [];
    // 沙箱執行,不給頁面碰 require/process/fs(遠端內容不可信)
    const nuxt = runInNewContext(m[1], {}, { timeout: 5000 });
    const stockList = ((nuxt.data || [])[0] || {}).stockList || [];
    return stockList
      .filter(s => /^\d{4}$/.test(String(s.stockId)))
      .map(s => ({ id: String(s.stockId), name: s.stockName }));
  } catch (e) {
    process.stderr.write(`  ERROR ${code}: ${e.message}\n`);
    return [];
  }
}

async function main() {
  const results = [];
  const BATCH = 15;

  for (let i = 0; i < CATEGORIES.length; i += BATCH) {
    const batch = CATEGORIES.slice(i, i + BATCH);
    const batchResults = await Promise.all(
      batch.map(async cat => {
        const stocks = await fetchStocks(cat.code);
        process.stderr.write(`  ${cat.parent} > ${cat.name}: ${stocks.length} stocks\n`);
        return { parent: cat.parent, name: cat.name, code: cat.code, stocks };
      })
    );
    results.push(...batchResults);
    if (i + BATCH < CATEGORIES.length) await new Promise(r => setTimeout(r, 400));
  }

  const empty = results.filter(r => r.stocks.length === 0);
  const total = results.reduce((s, r) => s + r.stocks.length, 0);
  // 全空代表被擋或改版,不要把好資料蓋掉
  if (total === 0) {
    process.stderr.write('All categories empty - aborting without writing.\n');
    process.exit(1);
  }

  mkdirSync(join(ROOT, 'data'), { recursive: true });
  const out = join(ROOT, 'data', 'categories.json');

  // 部分改版防呆:跟現有檔比,總股數掉 >15% 或原本非空的分類變空,寧可不寫
  if (existsSync(out)) {
    const prev = JSON.parse(readFileSync(out, 'utf8'));
    const prevTotal = prev.reduce((s, r) => s + r.stocks.length, 0);
    const prevNonEmpty = new Set(prev.filter(r => r.stocks.length > 0).map(r => r.code));
    const wentEmpty = results.filter(r => r.stocks.length === 0 && prevNonEmpty.has(r.code));
    if (total < prevTotal * 0.85 || wentEmpty.length) {
      process.stderr.write(`SANITY FAIL: total ${total} (prev ${prevTotal}), newly-empty: ${wentEmpty.map(r => r.name).join(',') || 'none'} - aborting without writing.\n`);
      process.exit(1);
    }
  }
  writeFileSync(out, JSON.stringify(results, null, 2), 'utf8');
  process.stderr.write(`\nDone: ${results.length} categories (${empty.length} empty), ${total} stock entries\nSaved -> ${out}\n`);
}

main();
