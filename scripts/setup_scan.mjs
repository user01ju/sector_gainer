// Qullamaggie 式收縮/突破判定(純函式,build_report.mjs 呼叫)。
// 移植自 capital_stock_api/setup_scan.py,判準與參數必須一模一樣 —— 改一邊就要改另一邊,
// 再跑 scripts/parity_setup.mjs 對拍。
//
// 輸入:還原 H/L/C(已換算成「今日價位」尺度)+ 量,陣列舊→新,最後一根 = 評估日。
//   flag(收縮待突破):動能腿後回檔、振幅與量都縮、守上彎 MA20、貼近樞紐(近 10 日高)。
//   brk (今日突破)  :昨天還是 flag,今天收盤越過昨天的樞紐且放量。
// 收縮度以 ADR60、距離以 ADR20 正規化,高低波動股才比得起來。動能腿本身交給上游 rank 池負責。

const LEG_WIN = 63;           // 腿高回看(約 3 個月)
const PIVOT_WIN = 10;         // 樞紐 = 近 10 日還原高
const MIN_DAYS_OFF_HIGH = 3;  // 腿高後至少休息幾根
const MAX_DAYS_OFF_HIGH = 40; // 超過 = 高點貼著窗口邊緣的長底,不是「近期回檔」
const MAX_OFF_HIGH = -25.0;   // 距腿高 % 下限,回更深就不算旗形
const TIGHT_MAX = 0.85;       // 近 5 日平均振幅 / ADR60 上限(ADR20 跟近 5 日重疊,收縮會自己拉低分母)
const VQ_MAX = 0.9;           // 5 日均量 / 50 日均量 上限
const PIVOT_ADR_MAX = 2.0;    // 收盤距樞紐(ADR 倍數)上限
const DAY_ADR_MAX = 0.8;      // 評估日漲跌幅(ADR 倍數)上限,大漲大跌當天不算收縮
const BRK_VOL = 1.5;          // 突破日量 / 前 50 日均量 下限

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const rangeAvg = (h, l) => mean(h.map((x, i) => x / l[i] - 1)) * 100;
const r = (x, d) => +x.toFixed(d);

/** 通過回傳指標物件,否則 null。score 越低越好。 */
export function flag(h, l, c, v) {
  if (c.length < 60) return null;
  const n = c.length;
  const adr = rangeAvg(h.slice(-20), l.slice(-20));
  const adr60 = rangeAvg(h.slice(-60), l.slice(-60));
  const v50 = mean(v.slice(-50));
  if (!(adr > 0) || !(v50 > 0)) return null;
  const leg = h.slice(-LEG_WIN);
  let hiI = 0;
  for (let i = 1; i < leg.length; i++) if (leg[i] > leg[hiI]) hiI = i;   // 同 np.argmax:取第一個最大值
  const daysOff = leg.length - 1 - hiI;
  const off = (c[n - 1] / leg[hiI] - 1) * 100;
  const tight = rangeAvg(h.slice(-5), l.slice(-5)) / adr60;
  const vq = mean(v.slice(-5)) / v50;
  const ma20 = mean(c.slice(-20)), ma20Prev = mean(c.slice(-25, -5));
  const pivot = Math.max(...h.slice(-PIVOT_WIN));
  const dist = (pivot / c[n - 1] - 1) * 100 / adr;
  const day = Math.abs(c[n - 1] / c[n - 2] - 1) * 100 / adr;
  if (daysOff < MIN_DAYS_OFF_HIGH || daysOff > MAX_DAYS_OFF_HIGH || off < MAX_OFF_HIGH || tight > TIGHT_MAX || vq > VQ_MAX
      || c[n - 1] < ma20 || ma20 <= ma20Prev || dist > PIVOT_ADR_MAX || day > DAY_ADR_MAX) return null;
  // 區間收縮比:近 5 日高低區間 / 前 5 日(<1 = VCP 式越收越窄),只計分不當門檻
  const r5 = Math.max(...h.slice(-5)) / Math.min(...l.slice(-5)) - 1;
  const rPrev = Math.max(...h.slice(-10, -5)) / Math.min(...l.slice(-10, -5)) - 1;
  const rc = rPrev > 0 ? r5 / rPrev : 1.0;
  const stop = Math.min(...l.slice(-5));   // 整理區低點;實際停損用進場日 LOD,這裡給上限參考
  return {
    adr: r(adr, 2), offHigh: r(off, 1), daysOff,
    tight: r(tight, 2), vq: r(vq, 2), rc: r(rc, 2),
    pivot: r(pivot, 2), distAdr: r(dist, 2),
    stop: r(stop, 2), riskPct: r((pivot / stop - 1) * 100, 1),
    ma20Pct: r((c[n - 1] / ma20 - 1) * 100, 1),
    score: r(tight + vq + dist / PIVOT_ADR_MAX + Math.min(rc, 2.0), 2),
  };
}

/** 昨天 flag + 今天收盤 > 昨天樞紐 + 量 ≥ BRK_VOL × 前 50 日均量。停損 = 今日低(LOD)。 */
export function brk(h, l, c, v) {
  const f = flag(h.slice(0, -1), l.slice(0, -1), c.slice(0, -1), v.slice(0, -1));
  if (!f) return null;
  const n = c.length;
  const volx = v[n - 1] / mean(v.slice(-51, -1));
  if (c[n - 1] <= f.pivot || volx < BRK_VOL) return null;
  return {
    ...f,
    chgPct: r((c[n - 1] / c[n - 2] - 1) * 100, 1), volx: r(volx, 2),
    stop: r(l[n - 1], 2), riskPct: r((c[n - 1] / l[n - 1] - 1) * 100, 1),
  };
}
