// 收縮/突破形狀指標(純函式,build_report.mjs 呼叫)。只算數值、不當篩選條件 ——
// 篩選走 Qullamaggie 原版(C/MinL 動能 rank + ADR),形狀交給看圖。
// 定義沿用 capital_stock_api/setup_scan.py(那邊仍拿來當門檻;門檻值列在各欄註解供參考)。
//
// 輸入:還原 H/L/C(已換算成「今日價位」尺度)+ 量,陣列舊→新,最後一根 = 評估日。
// 收縮度以 ADR60、距離以 ADR20 正規化,高低波動股才比得起來。

const LEG_WIN = 63;    // 腿高回看(約 3 個月)
const PIVOT_WIN = 10;  // 樞紐 = 近 10 日還原高

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const rangeAvg = (h, l) => mean(h.map((x, i) => x / l[i] - 1)) * 100;
const r = (x, d) => +x.toFixed(d);

/** 不足 60 根或量/振幅無效回傳 null。 */
export function shape(h, l, c, v) {
  if (c.length < 60) return null;
  const n = c.length;
  const adr = rangeAvg(h.slice(-20), l.slice(-20));
  const adr60 = rangeAvg(h.slice(-60), l.slice(-60));
  const v50 = mean(v.slice(-51, -1));
  if (!(adr > 0) || !(v50 > 0)) return null;
  const leg = h.slice(-LEG_WIN);
  let hiI = 0;
  for (let i = 1; i < leg.length; i++) if (leg[i] > leg[hiI]) hiI = i;
  const pivot = Math.max(...h.slice(-PIVOT_WIN));
  const ma20 = mean(c.slice(-20));
  // 區間收縮比:近 5 日高低區間 / 前 5 日(<1 = VCP 式越收越窄)
  const r5 = Math.max(...h.slice(-5)) / Math.min(...l.slice(-5)) - 1;
  const rPrev = Math.max(...h.slice(-10, -5)) / Math.min(...l.slice(-10, -5)) - 1;
  const rc = rPrev > 0 ? r5 / rPrev : 1.0;
  const tight = rangeAvg(h.slice(-5), l.slice(-5)) / adr60;
  const vq = mean(v.slice(-5)) / mean(v.slice(-50));
  const dist = (pivot / c[n - 1] - 1) * 100 / adr;
  const stop = Math.min(...l.slice(-5));   // 整理區低點;實際停損用進場日 LOD
  return {
    offHigh: r((c[n - 1] / leg[hiI] - 1) * 100, 1),   // 距 63 根高 %(setup_scan 門檻 ≥ −25)
    daysOff: leg.length - 1 - hiI,                    // 高點後幾根(3~40)
    tight: r(tight, 2),                               // 5 日振幅 / ADR60(≤ 0.85)
    vq: r(vq, 2),                                     // 5 日均量 / 50 日均量(≤ 0.9)
    rc: r(rc, 2),
    pivot: r(pivot, 2),
    distAdr: r(dist, 2),                              // 收盤距樞紐 / ADR(≤ 2)
    stop: r(stop, 2), riskPct: r((pivot / stop - 1) * 100, 1),
    ma20Pct: r((c[n - 1] / ma20 - 1) * 100, 1),
    score: r(tight + vq + dist / 2 + Math.min(rc, 2.0), 2),
    volx: r(v[n - 1] / v50, 2),                       // 今日量 / 前 50 日均量(突破 ≥ 1.5)
  };
}
