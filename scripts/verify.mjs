// 資料正確性驗證(方案見 VERIFICATION.md)
// Tier A = 零外部呼叫,只讀 repo 內既有檔案,掛在 daily.yml 的 commit 之前
// Tier B = 交叉源(twse_website gh-pages),獨立 workflow 每日跑
//
// Usage:
//   node scripts/verify.mjs --tier a     只跑 Tier A
//   node scripts/verify.mjs --tier b     只跑 Tier B
//   node scripts/verify.mjs              = --tier all(預設)
//
// Exit code: 0 = 全過(或只有 SKIP) / 1 = 至少一條 FAIL / 2 = 沒 FAIL 但有 WARN
// 本 repo 是四專案的資料 hub(data/daily、data/exrights.csv、data/market_index.csv
// 被 financial_report、capital_stock_api、twse_website 引用),壞資料會往外擴散,
// 所以 Tier A 的不變量寧可嚴一點。
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAILY_DIR = join(ROOT, 'data', 'daily');

// ---------------- 門檻(集中管理) ----------------

// report.json 落後「已確認交易日」超過幾天算 FAIL。
// 1 天是正常的(build_report 可能剔除當天毒日),2 天還在補抓射程內(fetch --backfill 7),
// 3 天以上代表 TWSE 連續被擋而 CI 仍天天綠色 —— 正是要抓的無告警停更。
const STALE_TRADING_DAYS = 2;
// 退化路徑:當 market_index.csv 自己也停更(TWSE 整批被擋)時無法確認交易日,
// 只能數「週間日」。台股最長連續休市(春節+彈性放假)約 7 個週間日,取 8 才 FAIL,
// 中間區間給 WARN。這是刻意保守 —— 寧可晚兩天紅,也不要每逢春節就假警報。
const STALE_WEEKDAY_HARD = 8;
// 台北 15:00 前當天盤後資料本來就還沒齊,基準日往前推一個週間日
const DATA_READY_HOUR_TPE = 15;

// OHLC / schema 掃描的近期檔數。Tier A 要 <10 秒,每檔約 2000 列,10 檔綽綽有餘。
const SCAN_DAYS = 10;
// 單日列數低於近期中位數的這個比例 = 檔案被截斷(fetch 單邊缺漏本該不寫檔)
const ROWS_MIN_RATIO = 0.9;
// 絕對下限:fetch_daily 的門檻是 TWSE>=500 + TPEX>=300
const ROWS_ABS_FLOOR = 800;

// 類股成分權重總和容差(report.json 的 weight 是 2dp 百分比,87 檔累積捨入誤差 <0.5)
const WEIGHT_SUM_TOL = 0.5;
// 用原始 csv 重算類股加權漲幅 vs report.json 的容差(百分點)
const SECTOR_RECALC_TOL = 0.05;
// 重算抽幾個類股(取成交金額最大的前 N 個,結果穩定可比對)
const SECTOR_RECALC_N = 3;

// 指數單日變動上限:成分股各自受 ±10% 漲跌幅限制,指數在數學上不可能超過 ±10%,
// 超過 = 資料尺度錯亂/串錯日期。留 0.5pp 給除權息與新股納入。
const INDEX_MOVE_FAIL = 10.5;
const INDEX_MOVE_WARN = 9.0;
// 指數檢查只看近 250 列(約一年),更早的歷史沒必要每天重掃
const INDEX_SCAN_ROWS = 250;
// market_index.csv 早期(2025-05~06)otc 欄是 0,近期不該再出現
const OTC_REQUIRED_ROWS = 60;

// 除權息參考價 / 前一日收盤 的合理區間(實測 2626 筆落在 0.66~1.02)
const EXREF_RATIO_MIN = 0.5;
const EXREF_RATIO_MAX = 1.1;
// 除權息日缺 daily 檔:近幾個交易日內算 FAIL(backfill 7 還救得回來,擋 commit 有意義),
// 更早的算 WARN —— 歷史破洞要手動 force backfill,不該把每日 pipeline 永久卡死。
const EXRIGHTS_HOLE_RECENT_TD = 5;

// Tier B
const FETCH_TIMEOUT_MS = 15000;
const CALL_GAP_MS = 1200;          // 兩次外部呼叫之間至少間隔(spec 要求 >=1 秒)
const MAX_EXTERNAL_CALLS = 3;      // 硬上限,超過就 SKIP
const GH_RAW = 'https://raw.githubusercontent.com/user01ju/twse_website/gh-pages';
const INDEX_CLOSE_TOL_PCT = 0.05;  // 指數 close 兩邊差異容差(%)
const EXREF_CROSS_TOL_PCT = 0.5;   // 除權息參考價兩邊差異容差(%)
const EXRIGHTS_CROSS_DAYS = 370;   // 本 repo 只保留近 370 天,超出範圍不比
// 漏抓除權息造成的假跳空:還原鏈上出現與配息幅度相符、且幅度夠大的跌幅才算實錯
const FAKE_GAP_MIN_PCT = 1.0;      // 配息幅度小於這個值,雜訊蓋過訊號,不判
const FAKE_GAP_MATCH_PP = 1.5;     // 實際報酬與配息幅度差在這個百分點內 = 假跳空

// ---------------- 小工具 ----------------

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isWeekday = iso => { const d = new Date(iso + 'T00:00:00Z').getUTCDay(); return d !== 0 && d !== 6; };
const addDays = (iso, n) => new Date(new Date(iso + 'T00:00:00Z').getTime() + n * 86400e3).toISOString().slice(0, 10);
const taipeiNow = () => new Date(Date.now() + 8 * 3600e3);
const taipeiToday = () => taipeiNow().toISOString().slice(0, 10);

// (from, to] 之間的週間日數
function weekdaysBetween(from, to) {
  let n = 0;
  for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) if (isWeekday(d)) n++;
  return n;
}

// 盤後資料齊全前不該拿當天當基準
function referenceDay() {
  let d = taipeiToday();
  if (taipeiNow().getUTCHours() < DATA_READY_HOUR_TPE) d = addDays(d, -1);
  while (!isWeekday(d)) d = addDays(d, -1);
  return d;
}

const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (a, b) => (a / b - 1) * 100;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function splitCsv(path) {
  return readFileSync(path, 'utf8').split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.length);
}

// ---------------- 共用資料載入(lazy + cache) ----------------

const ctx = {
  _c: new Map(),
  memo(k, fn) { if (!this._c.has(k)) this._c.set(k, fn()); return this._c.get(k); },

  // 交易日來源:market_index.csv 的日期序列就是實際交易日(本 repo 最可靠的來源,
  // 其他三個 repo 也會來抓這個檔,所以順便驗它的完整性)。
  get tradingDates() {
    return this.memo('td', () => {
      const p = join(ROOT, 'data', 'market_index.csv');
      if (!existsSync(p)) return [];
      return splitCsv(p).slice(1).map(l => l.split(',')[0]).filter(d => ISO.test(d));
    });
  },
  get indexRows() {
    return this.memo('ix', () => {
      const p = join(ROOT, 'data', 'market_index.csv');
      if (!existsSync(p)) return [];
      return splitCsv(p).slice(1).map(l => {
        const [date, taiex, otc] = l.split(',');
        return { date, taiex: taiex === '' ? null : +taiex, otc: otc === '' ? null : +otc };
      }).filter(r => ISO.test(r.date));
    });
  },
  get dailyDates() {
    return this.memo('dd', () => existsSync(DAILY_DIR)
      ? readdirSync(DAILY_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.csv$/.test(f)).map(f => f.slice(0, 10)).sort()
      : []);
  },
  day(date) {
    return this.memo('day:' + date, () => {
      const rows = [];
      for (const ln of splitCsv(join(DAILY_DIR, `${date}.csv`)).slice(1)) {
        const p = ln.split(',');
        if (!p[0]) continue;
        rows.push({
          id: p[0], name: p[1], market: p[2], close: +p[3],
          change: p[4] === '' ? null : +p[4], turnover: +p[5],
          high: p[6] === '' || p[6] == null ? null : +p[6],
          low: p[7] === '' || p[7] == null ? null : +p[7],
          cols: p.length,
        });
      }
      return rows;
    });
  },
  dayMap(date) { return this.memo('dm:' + date, () => new Map(this.day(date).map(r => [r.id, r]))); },
  get exrights() {
    return this.memo('ex', () => {
      const p = join(ROOT, 'data', 'exrights.csv');
      if (!existsSync(p)) return [];
      return splitCsv(p).slice(1).map(l => {
        const [date, id, ref] = l.split(',');
        return { date, id, ref: +ref };
      }).filter(r => r.date && r.id);
    });
  },
  get exMap() { return this.memo('exm', () => new Map(this.exrights.map(r => [`${r.date}|${r.id}`, r.ref]))); },
  get report() { return this.memo('rp', () => JSON.parse(readFileSync(join(ROOT, 'docs', 'report.json'), 'utf8'))); },
};

// ---------------- Tier A ----------------

// VERIFICATION.md Tier A #1 —— 本 repo 最重要的一條。
// daily.yml 的 commit step 是 `git diff --cached --quiet && echo "no changes" && exit 0`,
// TWSE 連續被擋時它天天綠色、報表默默停更;這條掛在它之前才擋得住。
function checkReportStale() {
  const r = ctx.report;
  if (!ISO.test(r.date || '')) return ['FAIL', `report.json date 非法:${JSON.stringify(r.date)}`];
  const ref = referenceDay();
  if (r.date >= ref) return ['PASS', `report.json ${r.date} 已到基準交易日 ${ref}`];

  const td = ctx.tradingDates;
  const lastTd = td.length ? td[td.length - 1] : null;
  // 已確認的交易日落後(market_index.csv 有、報表沒有的日子)
  const confirmed = td.filter(d => d > r.date).length;
  // market_index 也停更之後的部分只能數週間日,可能含國定假日
  const unconfirmed = weekdaysBetween(lastTd && lastTd > r.date ? lastTd : r.date, ref);
  const msg = `report.json ${r.date},落後已確認交易日 ${confirmed} 天` +
    `(門檻 ${STALE_TRADING_DAYS})+ 未確認週間日 ${unconfirmed} 天(門檻 ${STALE_WEEKDAY_HARD});` +
    `market_index 最新 ${lastTd ?? 'n/a'},基準日 ${ref}`;
  if (confirmed > STALE_TRADING_DAYS) return ['FAIL', msg];
  if (unconfirmed > STALE_WEEKDAY_HARD) return ['FAIL', msg + ' — 連 market_index 都停更,判定資料源整批被擋'];
  if (confirmed + unconfirmed > STALE_TRADING_DAYS) return ['WARN', msg + ' — 可能是連假,未達硬門檻'];
  return ['PASS', msg];
}

// build_report 有沒有真的吃到最新的 daily 檔(剔除毒日會合法落後 1 天)
function checkReportVsDailyLatest() {
  const r = ctx.report, dd = ctx.dailyDates;
  if (!dd.length) return ['FAIL', 'data/daily 沒有任何檔案'];
  if (!dd.includes(r.date)) return ['FAIL', `report.json date ${r.date} 在 data/daily 找不到對應檔(最新檔 ${dd[dd.length - 1]})`];
  const behind = dd.filter(d => d > r.date).length;
  const msg = `report.json ${r.date},比最新 daily 檔 ${dd[dd.length - 1]} 落後 ${behind} 個交易日檔`;
  if (behind >= 2) return ['FAIL', msg + '(>=2,build_report 沒重跑或連續剔除毒日)'];
  if (behind === 1) return ['WARN', msg + '(=1,通常是 build_report 剔除當日毒日)'];
  return ['PASS', msg];
}

// VERIFICATION.md Tier A #2
function checkOhlcInvariants() {
  const dd = ctx.dailyDates.slice(-SCAN_DAYS);
  if (!dd.length) return ['FAIL', 'data/daily 沒有任何檔案'];
  let rows = 0, bad = 0;
  const samples = [];
  for (const d of dd) {
    for (const r of ctx.day(d)) {
      rows++;
      const errs = [];
      if (!Number.isFinite(r.close) || r.close <= 0) errs.push(`close=${r.close}`);
      if (!Number.isFinite(r.turnover) || r.turnover < 0) errs.push(`turnover=${r.turnover}`);
      if (r.high != null && r.low != null) {
        if (!(r.low > 0)) errs.push(`low=${r.low}`);
        else if (!(r.low <= r.high)) errs.push(`low ${r.low} > high ${r.high}`);
        else if (!(r.low <= r.close && r.close <= r.high)) errs.push(`close ${r.close} 不在 [${r.low}, ${r.high}]`);
      }
      if (errs.length) { bad++; if (samples.length < 3) samples.push(`${d} ${r.id} ${r.name} ${errs.join('/')}`); }
    }
  }
  const msg = `近 ${dd.length} 個交易日 ${rows} 列,違反 low<=close<=high / turnover>=0 共 ${bad} 列(門檻 0)`;
  return bad ? ['FAIL', `${msg}:${samples.join(' ; ')}`] : ['PASS', msg];
}

// 檔案結構完整性 —— 這幾個檔被另外兩個 repo 直接讀,截斷/欄位漂移會擴散出去
function checkDailyCsvSchema() {
  const HEADER = 'id,name,market,close,change,turnover,high,low';
  const dd = ctx.dailyDates.slice(-SCAN_DAYS);
  if (!dd.length) return ['FAIL', 'data/daily 沒有任何檔案'];
  const problems = [];
  const counts = dd.map(d => ctx.day(d).length);
  const med = median(counts);
  let hlMissing = 0, hlTotal = 0;
  dd.forEach((d, i) => {
    const head = splitCsv(join(DAILY_DIR, `${d}.csv`))[0];
    if (head !== HEADER) problems.push(`${d} header=${JSON.stringify(head)}`);
    const rows = ctx.day(d);
    if (counts[i] < ROWS_ABS_FLOOR || counts[i] < med * ROWS_MIN_RATIO)
      problems.push(`${d} 只有 ${counts[i]} 列(中位數 ${med},下限 ${Math.max(ROWS_ABS_FLOOR, Math.round(med * ROWS_MIN_RATIO))})`);
    const ids = new Set();
    let dup = 0, badMkt = 0, badCols = 0;
    for (const r of rows) {
      if (ids.has(r.id)) dup++; else ids.add(r.id);
      if (r.market !== 'TWSE' && r.market !== 'TPEX') badMkt++;
      if (r.cols !== 8) badCols++;
      hlTotal++;
      if (r.high == null || r.low == null) hlMissing++;
    }
    if (dup) problems.push(`${d} 重複 id ${dup} 筆`);
    if (badMkt) problems.push(`${d} market 欄非 TWSE/TPEX ${badMkt} 筆`);
    if (badCols) problems.push(`${d} 欄位數非 8 的列 ${badCols} 筆`);
  });
  if (problems.length) return ['FAIL', `近 ${dd.length} 檔 daily csv:${problems.slice(0, 4).join(' ; ')}${problems.length > 4 ? ` …共 ${problems.length} 項` : ''}`];
  const hlPct = hlTotal ? hlMissing / hlTotal * 100 : 0;
  const msg = `近 ${dd.length} 檔 daily csv header/列數/id 唯一性/market 欄皆正常(中位數 ${med} 列),high/low 缺值 ${hlPct.toFixed(1)}%`;
  if (hlPct > 20) return ['WARN', msg + ' — 缺值 >20%,ADR/收縮度指標會失真(需跑 fetch_daily --augment)'];
  return ['PASS', msg];
}

// 除權息日 TWSE/TPEX 不給漲跌價差(change 欄空),此時還原報酬只能靠參考價;
// 缺參考價 = 該檔當日漲跌幅靜默變成 0%,還原鏈也斷。llm_wiki: twse-exdiv-change-x-zero-pct
function checkBlankChangeHasRef() {
  const dd = ctx.dailyDates.slice(-SCAN_DAYS);
  if (!dd.length) return ['FAIL', 'data/daily 沒有任何檔案'];
  let blank = 0, miss = 0;
  const samples = [];
  for (const d of dd) {
    for (const r of ctx.day(d)) {
      if (r.change != null) continue;
      blank++;
      if (!ctx.exMap.has(`${d}|${r.id}`)) { miss++; if (samples.length < 3) samples.push(`${d} ${r.id} ${r.name}`); }
    }
  }
  const msg = `近 ${dd.length} 個交易日 change 欄為空 ${blank} 列,其中查無除權息參考價 ${miss} 列(門檻 0)`;
  return miss ? ['FAIL', `${msg}:${samples.join(' ; ')}`] : ['PASS', msg];
}

// VERIFICATION.md Tier A #3
function checkSectorWeightSum() {
  const secs = ctx.report.sectors || [];
  if (!secs.length) return ['FAIL', 'report.json 沒有任何類股'];
  const bad = [], zero = [];
  for (const s of secs) {
    const sum = s.stocks.reduce((a, x) => a + (x.weight || 0), 0);
    if (!s.turnover) { zero.push(s.name); continue; }
    if (Math.abs(sum - 100) > WEIGHT_SUM_TOL) bad.push(`${s.name} Σ=${sum.toFixed(2)}`);
  }
  const msg = `${secs.length} 個類股成分權重 Σ≈100(容差 ±${WEIGHT_SUM_TOL}),偏離 ${bad.length} 個`;
  if (bad.length) return ['FAIL', `${msg}:${bad.slice(0, 3).join(' ; ')}`];
  if (zero.length) return ['WARN', `${msg};另有 ${zero.length} 個類股當日成交金額為 0(權重全 0):${zero.slice(0, 3).join('、')}`];
  return ['PASS', msg];
}

// VERIFICATION.md Tier B #2,但零外部呼叫 → 放 Tier A 每次 CI 跑更有價值。
// 從原始 daily csv + exrights.csv 獨立重算「成交金額占比加權當日漲幅」比對 report.json。
function checkSectorRecalc() {
  const r = ctx.report;
  const day = ctx.dayMap(r.date);
  const picked = [...(r.sectors || [])].sort((a, b) => b.turnover - a.turnover).slice(0, SECTOR_RECALC_N);
  if (!picked.length) return ['FAIL', 'report.json 沒有任何類股'];
  const bad = [], detail = [];
  for (const s of picked) {
    let tot = 0;
    const rows = [];
    for (const st of s.stocks) {
      const q = day.get(st.id);
      if (!q) { bad.push(`${s.name}/${st.id} 在 ${r.date} 的 daily csv 找不到`); continue; }
      // 與 build_report 相同:除權息日用參考價當分母,否則用 close - change
      const ref = ctx.exMap.get(`${r.date}|${st.id}`) ?? (q.change != null ? q.close - q.change : q.close);
      rows.push({ turnover: q.turnover, d: ref > 0 ? pct(q.close, ref) : null });
      tot += q.turnover;
    }
    let wSum = 0, vSum = 0;
    for (const x of rows) { if (x.d == null) continue; const w = tot ? x.turnover / tot : 0; wSum += w; vSum += w * x.d; }
    const mine = wSum > 0 ? vSum / wSum : null;
    const diff = mine == null || s.d == null ? null : Math.abs(mine - s.d);
    detail.push(`${s.name} 重算 ${mine == null ? 'n/a' : mine.toFixed(3)} vs report ${s.d}`);
    if (diff == null || diff > SECTOR_RECALC_TOL) bad.push(`${s.name} 差 ${diff == null ? 'n/a' : diff.toFixed(3)}pp`);
    if (Math.abs(tot - s.turnover) > Math.max(1, s.turnover * 1e-9)) bad.push(`${s.name} 成交金額 ${tot} vs report ${s.turnover}`);
  }
  const msg = `抽 ${picked.length} 個成交金額最大的類股重算當日加權漲幅(容差 ${SECTOR_RECALC_TOL}pp):${detail.join(' ; ')}`;
  return bad.length ? ['FAIL', `${msg} — 不符:${bad.slice(0, 3).join(' ; ')}`] : ['PASS', msg];
}

// report.json / data.js / scanner.js 是網站與下游共同吃的產物,結構壞掉或彼此不同步都是靜默災難
function checkReportSchema() {
  const r = ctx.report;
  const problems = [];
  if (!ISO.test(r.date || '')) problems.push(`date=${JSON.stringify(r.date)}`);
  if (!Array.isArray(r.sectors) || r.sectors.length < 50) problems.push(`sectors 只有 ${r.sectors?.length}`);
  for (const s of r.sectors || []) {
    if (!s.stocks?.length) { problems.push(`${s.name} 沒有成分股`); break; }
    if (s.count !== s.stocks.length) { problems.push(`${s.name} count=${s.count} 但 stocks=${s.stocks.length}`); break; }
  }
  const b = r.breadth || {};
  if (!Array.isArray(b.dates) || !b.dates.length) problems.push('breadth.dates 空');
  else {
    if (b.above20?.length !== b.dates.length || b.net?.length !== b.dates.length)
      problems.push(`breadth 陣列長度不一致 dates=${b.dates.length} above20=${b.above20?.length} net=${b.net?.length}`);
    if (b.dates[b.dates.length - 1] !== r.date) problems.push(`breadth 最後日期 ${b.dates[b.dates.length - 1]} != report date ${r.date}`);
  }
  for (const k of ['taiex', 'otc']) {
    const m = r.market?.[k];
    if (m && !['green', 'red'].includes(m.light)) problems.push(`market.${k}.light=${m?.light}`);
  }
  // 網站讀的是 data.js 不是 report.json,兩者不同步 = 線上頁面靜默停在舊資料
  for (const [f, re] of [['data.js', /window\.REPORT=\{"date":"(\d{4}-\d{2}-\d{2})"/], ['scanner.js', /window\.SCANNER=\{"date":"(\d{4}-\d{2}-\d{2})"/]]) {
    const p = join(ROOT, 'docs', f);
    if (!existsSync(p)) { problems.push(`docs/${f} 不存在`); continue; }
    const m = readFileSync(p, 'utf8').slice(0, 200).match(re);
    if (!m) problems.push(`docs/${f} 開頭抓不到 date`);
    else if (m[1] !== r.date) problems.push(`docs/${f} date=${m[1]} != report.json ${r.date}`);
  }
  return problems.length
    ? ['FAIL', `report.json/docs 產物結構:${problems.slice(0, 4).join(' ; ')}`]
    : ['PASS', `report.json ${r.sectors.length} 類股、breadth ${r.breadth.dates.length} 點,docs/data.js 與 scanner.js 日期同步於 ${r.date}`];
}

// market_index.csv 同時是四個 repo 的交易日曆來源,壞了會連帶讓別人的驗證失準
function checkMarketIndexIntegrity() {
  const rows = ctx.indexRows;
  if (!rows.length) return ['FAIL', 'data/market_index.csv 不存在或空'];
  const problems = [];
  for (let i = 1; i < rows.length; i++) if (rows[i].date <= rows[i - 1].date) problems.push(`日期未嚴格遞增/重複 @${rows[i].date}`);
  const recent = rows.slice(-INDEX_SCAN_ROWS);
  for (const r of recent) {
    if (!(r.taiex > 0)) problems.push(`${r.date} taiex=${r.taiex}`);
    if (!isWeekday(r.date)) problems.push(`${r.date} 是週末卻有指數`);
  }
  for (const r of rows.slice(-OTC_REQUIRED_ROWS)) if (!(r.otc > 0)) problems.push(`${r.date} otc=${r.otc}`);
  let worst = 0, worstD = '', warn = 0;
  for (let i = 1; i < recent.length; i++) {
    for (const k of ['taiex', 'otc']) {
      const a = recent[i - 1][k], b = recent[i][k];
      if (!(a > 0) || !(b > 0)) continue;
      const m = Math.abs(pct(b, a));
      if (m > worst) { worst = m; worstD = `${recent[i].date} ${k}`; }
      if (m > INDEX_MOVE_FAIL) problems.push(`${recent[i].date} ${k} 單日 ${m.toFixed(2)}% > ${INDEX_MOVE_FAIL}%(成分股受 ±10% 限制,不可能)`);
      else if (m > INDEX_MOVE_WARN) warn++;
    }
  }
  const msg = `${rows.length} 列(${rows[0].date}~${rows[rows.length - 1].date}),近 ${recent.length} 列最大單日變動 ${worst.toFixed(2)}% @${worstD}(WARN ${INDEX_MOVE_WARN}% / FAIL ${INDEX_MOVE_FAIL}%)`;
  if (problems.length) return ['FAIL', `market_index.csv ${msg} — ${problems.slice(0, 3).join(' ; ')}${problems.length > 3 ? ` …共 ${problems.length} 項` : ''}`];
  if (warn) return ['WARN', `market_index.csv ${msg},其中 ${warn} 次超過 WARN 門檻`];
  return ['PASS', `market_index.csv ${msg}`];
}

// exrights.csv 是事件型檔案(只在除息日長),不可拿最新日期判斷落後 —— 只驗結構與值域。
// llm_wiki: sibling-repo-data-silently-stale
function checkExrightsIntegrity() {
  const rows = ctx.exrights;
  if (!rows.length) return ['FAIL', 'data/exrights.csv 不存在或空'];
  const problems = [];
  const seen = new Set();
  let dup = 0;
  for (const r of rows) {
    if (!ISO.test(r.date)) { problems.push(`日期格式 ${r.date}`); continue; }
    if (!/^\d{4}$/.test(r.id)) problems.push(`股號 ${r.id}`);
    if (!(r.ref > 0)) problems.push(`${r.date} ${r.id} ref=${r.ref}`);
    const k = `${r.date}|${r.id}`;
    if (seen.has(k)) dup++; else seen.add(k);
  }
  if (dup) problems.push(`重複 (date,id) ${dup} 筆`);
  // 參考價 vs 前一交易日收盤的比值(除權息幅度);超出區間 = 抓錯欄位或串錯股號
  const dd = ctx.dailyDates;
  let checked = 0, lo = Infinity, hi = 0;
  const outliers = [];
  for (const r of rows) {
    const i = dd.indexOf(r.date);
    if (i < 1) continue;
    const prev = ctx.dayMap(dd[i - 1]).get(r.id);
    if (!prev || !(prev.close > 0)) continue;
    const ratio = r.ref / prev.close;
    checked++;
    if (ratio < lo) lo = ratio;
    if (ratio > hi) hi = ratio;
    if (ratio < EXREF_RATIO_MIN || ratio > EXREF_RATIO_MAX)
      outliers.push(`${r.date} ${r.id} ${prev.close}->${r.ref}(${ratio.toFixed(3)})`);
  }
  const msg = `${rows.length} 筆、${seen.size} 個 (date,id);ref/前收 比值 ${checked} 筆檢查,範圍 ${lo === Infinity ? 'n/a' : lo.toFixed(3)}~${hi.toFixed(3)}(合理區間 ${EXREF_RATIO_MIN}~${EXREF_RATIO_MAX})`;
  if (problems.length || outliers.length)
    return ['FAIL', `exrights.csv ${msg} — ${[...problems, ...outliers].slice(0, 3).join(' ; ')}`];
  return ['PASS', `exrights.csv ${msg}`];
}

// 除權息日沒有對應的 daily 檔,有兩種完全不同的成因,修法相反:
//  (1) 全市場休市(颱風假):market_index.csv 同樣沒那天。除權息實際順延到次一交易日
//      —— 交易所在那天才拿參考價當基準算漲跌。build_report 的順延邏輯會處理,
//      這裡只驗「順延得成」。實例:2026-07-10 颱風休市,17 檔順延到 07-13。
//  (2) 單日漏抓:market_index 有那天、daily 沒有。這才是真的破洞,要 backfill,
//      否則還原鏈把整段配息缺口當成真實下跌(build_report 的 ±12% band 只擋得住大額,
//      -3%~-8% 的一般配息會完整污染報酬)。
function checkExrightsDateHasDaily() {
  const dd = ctx.dailyDates;
  if (!dd.length) return ['FAIL', 'data/daily 沒有任何檔案'];
  const have = new Set(dd);
  const isTradingDay = new Set(ctx.tradingDates);
  const first = dd[0], last = dd[dd.length - 1];
  const exByDate = new Map();                      // date -> [id]
  const exKeys = new Set(ctx.exrights.map(r => `${r.date}|${r.id}`));
  for (const r of ctx.exrights) {
    if (r.date < first || r.date > last) continue; // 超出 daily 覆蓋範圍不算
    if (have.has(r.date)) continue;
    if (!exByDate.has(r.date)) exByDate.set(r.date, []);
    exByDate.get(r.date).push(r.id);
  }
  if (!exByDate.size) return ['PASS', `exrights.csv 的 ${new Set(ctx.exrights.map(r => r.date)).size} 個除權息日在 data/daily 都有對應行情檔`];

  const missed = [], rolled = [], unrollable = [];
  for (const [d, ids] of [...exByDate.entries()].sort()) {
    if (isTradingDay.has(d)) { missed.push(`${d}(${ids.length} 檔)`); continue; }
    // 休市日:確認 build_report 的順延目標可用(次一交易日在 5 天內、且未被占用)
    const next = dd.find(x => x > d);
    const gapOk = next && (new Date(next) - new Date(d)) / 86400e3 <= 5;
    const clash = next ? ids.filter(id => exKeys.has(`${next}|${id}`)) : ids;
    if (gapOk && !clash.length) rolled.push(`${d}→${next}(${ids.length} 檔)`);
    else unrollable.push(`${d}(${ids.length} 檔${!next ? ',無次一交易日' : !gapOk ? `,次一交易日 ${next} 隔太遠` : `,${clash.length} 檔與 ${next} 的除權息撞鍵`})`);
  }

  const parts = [];
  if (rolled.length) parts.push(`休市順延 ${rolled.join('、')}`);
  if (unrollable.length) parts.push(`休市但順延不了 ${unrollable.join('、')}`);
  if (missed.length) parts.push(`漏抓 ${missed.join('、')}`);
  const msg = parts.join(' ; ');

  if (unrollable.length) return ['FAIL', `${msg} — 順延不了的除權息會被當成真實下跌,需人工處理`];
  if (!missed.length) return ['PASS', `${msg} — 皆為全市場休市(market_index 同樣無該日),build_report 已順延至次一交易日`];
  const recentCut = dd[Math.max(0, dd.length - EXRIGHTS_HOLE_RECENT_TD)];
  const recent = missed.filter(s => s.slice(0, 10) >= recentCut);
  const tail = `— 該日 market_index 有、daily 沒有 = 真的漏抓;修法 node scripts/fetch_daily.mjs <日期>`;
  return recent.length
    ? ['FAIL', `${msg} ${tail}(其中 ${recent.join('、')} 在近 ${EXRIGHTS_HOLE_RECENT_TD} 個交易日內,backfill 7 還救得回來)`]
    : ['WARN', `${msg} ${tail}(皆早於近 ${EXRIGHTS_HOLE_RECENT_TD} 個交易日,需手動補抓,不擋 pipeline)`];
}

// 本 repo 是資料 hub:這四個產物被 financial_report / capital_stock_api / twse_website 直接讀
function checkHubFiles() {
  const problems = [], ok = [];
  for (const rel of ['data/exrights.csv', 'data/market_index.csv', 'data/categories.json']) {
    const p = join(ROOT, rel);
    if (!existsSync(p)) { problems.push(`${rel} 不存在`); continue; }
    const sz = statSync(p).size;
    if (sz < 100) problems.push(`${rel} 只有 ${sz} bytes`);
    else ok.push(`${rel} ${(sz / 1024).toFixed(0)}KB`);
  }
  const dd = ctx.dailyDates;
  if (dd.length < 60) problems.push(`data/daily 只有 ${dd.length} 個檔(下游取月底收盤/52 週高低需要長序列)`);
  else ok.push(`data/daily ${dd.length} 檔 ${dd[0]}~${dd[dd.length - 1]}`);
  try {
    const cats = JSON.parse(readFileSync(join(ROOT, 'data', 'categories.json'), 'utf8'));
    if (!Array.isArray(cats) || cats.length < 50) problems.push(`categories.json 只有 ${cats?.length} 個分類`);
    else {
      const empty = cats.filter(c => !c.stocks?.length).length;
      const total = cats.reduce((a, c) => a + (c.stocks?.length || 0), 0);
      if (empty) problems.push(`categories.json 有 ${empty} 個空分類`);
      else ok.push(`categories.json ${cats.length} 分類/${total} 檔`);
    }
  } catch (e) { problems.push(`categories.json 解析失敗:${e.message}`); }
  return problems.length ? ['FAIL', `資料 hub 產物:${problems.join(' ; ')}`] : ['PASS', `資料 hub 產物齊備:${ok.join('、')}`];
}

// ---------------- Tier B(外部呼叫) ----------------

let callsUsed = 0, lastCallAt = 0;

async function httpGet(url) {
  if (callsUsed >= MAX_EXTERNAL_CALLS) throw Object.assign(new Error(`已達外部呼叫上限 ${MAX_EXTERNAL_CALLS}`), { skip: true });
  const wait = CALL_GAP_MS - (Date.now() - lastCallAt);
  if (lastCallAt && wait > 0) await sleep(wait);
  callsUsed++;
  lastCallAt = Date.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { 'User-Agent': 'sector_gainer-verify' } });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { skip: true });
  return await res.text();
}

// 外部源掛掉不是我們的資料錯 → SKIP
const asSkip = (id, e) => ['SKIP', `${id} 外部源不可用(${e.message}),不判定`];

// VERIFICATION.md Tier B #1:加權指數 close vs twse_website today.json
// 不假設 sibling checkout 存在,一律抓 gh-pages(publish_dir=./output,force_orphan)
async function checkIndexCrossTwseWebsite() {
  let up;
  try { up = JSON.parse(await httpGet(`${GH_RAW}/today.json`)); }
  catch (e) { return asSkip('twse_website today.json', e); }
  const upDate = up.date, upClose = up.taiex?.close;
  if (!ISO.test(upDate || '') || !(upClose > 0)) return ['SKIP', `twse_website today.json 沒有可用的 date/taiex.close(date=${upDate})`];
  const rows = ctx.indexRows;
  const last = rows.length ? rows[rows.length - 1].date : null;
  const mine = rows.find(r => r.date === upDate);
  if (!mine) {
    if (!last || upDate > last) return ['SKIP', `twse_website 已到 ${upDate},本 repo market_index 最新 ${last}(本地尚未更新,由 report-stale 判定)`];
    return ['FAIL', `twse_website 有 ${upDate} 的加權指數但本 repo market_index.csv 缺這一天(最新 ${last}) — 缺交易日會讓還原鏈跳空`];
  }
  const diff = Math.abs(pct(mine.taiex, upClose));
  const msg = `${upDate} 加權 close 本 repo ${mine.taiex} vs twse_website ${upClose},差 ${diff.toFixed(4)}%(容差 ${INDEX_CLOSE_TOL_PCT}%)`;
  return diff > INDEX_CLOSE_TOL_PCT ? ['FAIL', msg] : ['PASS', msg];
}

let upstreamEx = null; // 給 b2/b3 共用,只抓一次

async function loadUpstreamExrights() {
  if (upstreamEx) return upstreamEx;
  const txt = await httpGet(`${GH_RAW}/data/exrights.csv`);
  const map = new Map();
  for (const ln of txt.split('\n').slice(1)) {
    const [date, id, ref] = ln.replace(/\r$/, '').split(',');
    if (ISO.test(date || '') && id) map.set(`${date}|${id}`, +ref);
  }
  upstreamEx = map;
  return map;
}

// VERIFICATION.md cross-repo #3:本 repo exrights ⊂ twse_website 近 370 天
async function checkExrightsCrossTwseWebsite() {
  let up;
  try { up = await loadUpstreamExrights(); }
  catch (e) { return asSkip('twse_website exrights.csv', e); }
  if (!up.size) return ['SKIP', 'twse_website exrights.csv 解析後為空'];
  const cut = addDays(taipeiToday(), -EXRIGHTS_CROSS_DAYS);
  const dd = new Set(ctx.dailyDates);
  const last = ctx.dailyDates[ctx.dailyDates.length - 1];
  let common = 0;
  const mismatch = [], missing = [];
  for (const [k, ref] of up) {
    const [date] = k.split('|');
    if (date < cut || date > last) continue;
    const mine = ctx.exMap.get(k);
    if (mine == null) { if (dd.has(date)) missing.push(k); continue; } // 只算「本地有行情卻沒參考價」的
    common++;
    if (Math.abs(pct(mine, ref)) > EXREF_CROSS_TOL_PCT) mismatch.push(`${k} 本地 ${mine} vs 上游 ${ref}`);
  }
  const msg = `近 ${EXRIGHTS_CROSS_DAYS} 天:共同 ${common} 筆(參考價差 >${EXREF_CROSS_TOL_PCT}% 者 ${mismatch.length} 筆),` +
    `上游有、本地缺 ${missing.length} 筆(容差 0)`;
  if (mismatch.length) return ['FAIL', `exrights 交叉比對 ${msg} — ${mismatch.slice(0, 3).join(' ; ')}`];
  if (missing.length) return ['FAIL', `exrights 交叉比對 ${msg} — 漏抓會讓還原鏈吃到假跳空:${missing.slice(0, 5).join('、')}`];
  return ['PASS', `exrights 交叉比對 ${msg}`];
}

// VERIFICATION.md Tier B #3:除息日抽驗還原鏈連續性。
// 對「上游有、本地缺」的除權息事件,檢查本地報酬鏈當天是否出現與配息幅度相符的假跳空。
async function checkExrightsChainGap() {
  let up;
  try { up = await loadUpstreamExrights(); }
  catch (e) { return asSkip('twse_website exrights.csv', e); }
  const dd = ctx.dailyDates;
  const idxOf = new Map(dd.map((d, i) => [d, i]));
  const suspects = [];
  for (const [k, ref] of up) {
    const [date, id] = k.split('|');
    const i = idxOf.get(date);
    if (i == null || i < 1) continue;
    if (ctx.exMap.has(k)) continue;                    // 本地有參考價 → build_report 會正確還原
    const prev = ctx.dayMap(dd[i - 1]).get(id), cur = ctx.dayMap(date).get(id);
    if (!prev || !cur || !(prev.close > 0) || !(ref > 0)) continue;
    const divPct = pct(ref, prev.close);               // 配息造成的參考價缺口(負值)
    const realPct = pct(cur.close, prev.close);        // 本地鏈上會算出的「跌幅」
    if (Math.abs(divPct) < FAKE_GAP_MIN_PCT) continue;
    if (Math.abs(realPct - divPct) <= FAKE_GAP_MATCH_PP)
      suspects.push(`${date} ${id} 前收 ${prev.close}→參考價 ${ref}(${divPct.toFixed(2)}%),本地算出 ${realPct.toFixed(2)}%`);
  }
  const msg = `以 twse_website 的除權息事件反查本地還原鏈(配息幅度 >=${FAKE_GAP_MIN_PCT}%、實際報酬相符 ±${FAKE_GAP_MATCH_PP}pp 判為假跳空),命中 ${suspects.length} 筆(門檻 0)`;
  return suspects.length ? ['FAIL', `${msg}:${suspects.slice(0, 5).join(' ; ')}`] : ['PASS', msg];
}

// ---------------- runner ----------------

const TIER_A = [
  ['report-stale', checkReportStale],
  ['report-vs-daily-latest', checkReportVsDailyLatest],
  ['ohlc-invariants', checkOhlcInvariants],
  ['daily-csv-schema', checkDailyCsvSchema],
  ['exdiv-blank-change-has-ref', checkBlankChangeHasRef],
  ['sector-weight-sum', checkSectorWeightSum],
  ['sector-gain-recalc', checkSectorRecalc],
  ['report-schema', checkReportSchema],
  ['market-index-integrity', checkMarketIndexIntegrity],
  ['exrights-integrity', checkExrightsIntegrity],
  ['exrights-date-has-daily', checkExrightsDateHasDaily],
  ['hub-files-present', checkHubFiles],
];

const TIER_B = [
  ['index-close-vs-twse-website', checkIndexCrossTwseWebsite],
  ['exrights-vs-twse-website', checkExrightsCrossTwseWebsite],
  ['exrights-chain-gap', checkExrightsChainGap],
];

async function main() {
  const args = process.argv.slice(2);
  const ti = args.indexOf('--tier');
  const tier = (ti >= 0 ? (args[ti + 1] || 'all') : 'all').toLowerCase();
  if (!['a', 'b', 'all'].includes(tier)) {
    console.error(`unknown --tier ${tier}(可用:a / b / all)`);
    process.exit(1);
  }
  const checks = [...(tier === 'b' ? [] : TIER_A), ...(tier === 'a' ? [] : TIER_B)];
  const tally = { PASS: 0, FAIL: 0, WARN: 0, SKIP: 0 };
  for (const [id, fn] of checks) {
    let status, message;
    try { [status, message] = await fn(); }               // 單條例外只毒死自己,不 fail-fast
    catch (e) { status = 'FAIL'; message = `檢查拋出例外:${e.message}`; }
    tally[status]++;
    console.log(`[${status}] ${id} — ${message}`);
  }
  console.log(`verify: ${tally.PASS} passed, ${tally.FAIL} failed, ${tally.WARN} warned, ${tally.SKIP} skipped (tier=${tier})`);
  process.exit(tally.FAIL ? 1 : tally.WARN ? 2 : 0);
}

main();
