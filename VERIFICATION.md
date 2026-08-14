# 資料正確性驗證

> 2026-08-01 規劃、2026-08-02 實作。四專案通用框架（Tier A 每次 CI / Tier B 每日交叉源 / Tier C golden）。
> 本檔描述**現況**，不是計畫。

## 怎麼跑

```bash
node scripts/verify.mjs --tier a      # 零外部呼叫，<1 秒
node scripts/verify.mjs --tier b      # 交叉源，會打外部
node scripts/verify.mjs               # 預設 all
```

exit code：`0` 全過（或只有 SKIP）／`1` 至少一條 FAIL／`2` 沒 FAIL 但有 WARN。CI 只把 `1` 當失敗。

輸出每條一行 `[PASS|FAIL|WARN|SKIP] <check-id> — <訊息>`，訊息一律帶實際數值與門檻。所有檢查跑完才決定 exit code（不 fail-fast），單條拋例外只毒死自己。

## CI 掛法

- **Tier A** → `.github/workflows/daily.yml`，位置在 `build_report.mjs` 之後、commit step 之前。**FAIL 擋掉 commit**。這點很關鍵：commit step 是 `git diff --cached --quiet && echo "no changes" && exit 0`，正是「TWSE 連續被擋 → CI 天天綠色 no changes → 報表默默停更」的元凶，驗證掛在它之前才有意義。
- **Tier B** → `.github/workflows/verify.yml`，每日台北 21:00（UTC 13:00）獨立排程 + `workflow_dispatch`。排在本 repo 的 daily（台北 15~18:05）與 twse_website 的重試窗口之後。FAIL 只讓這個 workflow 紅。

## Tier A（12 條，零外部呼叫）

| check-id | 驗什麼 |
|---|---|
| `report-stale` | `docs/report.json` latestDate 落後 >2 交易日 |
| `report-vs-daily-latest` | report.json 與最新 daily 檔的落差 |
| `ohlc-invariants` | low ≤ open/close ≤ high、turnover ≥ 0 |
| `daily-csv-schema` | header／列數／id 唯一性／market 欄 |
| `exdiv-blank-change-has-ref` | change 欄為空的列必須查得到除權息參考價 |
| `sector-weight-sum` | 各子類股成分權重 Σ ≈ 100 |
| `sector-gain-recalc` | 抽 3 大類股重算成交金額占比加權漲幅 |
| `report-schema` | report.json 結構 + **`docs/data.js` / `scanner.js` 日期同步** |
| `market-index-integrity` | 日期嚴格遞增唯一、無週末列、單日變動上限 |
| `exrights-integrity` | 筆數／鍵唯一性／ref 對前收比值合理區間，**超區間再用當日成交價佐證** |
| `exrights-date-has-daily` | 除權息日缺行情檔，**分辨休市順延 vs 真漏抓** |
| `hub-files-present` | 資料 hub 四個產物齊備 |

幾個要點：

**`report-stale` 的交易日推算**：先用 `data/market_index.csv` 的日期序列算「已確認交易日落後」（門檻 2 → FAIL）；market_index 自己也停更的區段退化成數週間日（門檻 8 → FAIL，刻意大於台股最長連假約 7 個週間日，避免春節假警報），中間帶 WARN。基準日在台北 15:00 前會往前推一個週間日。

**`report-schema` 為什麼要驗 `data.js`**：GitHub Pages 上的頁面讀的是 `docs/data.js`（`index.html` 用 `<script src=data.js>`），`report.json` 其實沒人看。build 中途失敗或 commit 漏檔會變成「驗證全綠、網站停在舊資料」。

**`market-index-integrity` 為什麼重要**：這個檔現在是四個 repo 的交易日曆來源，它壞掉會讓另外三個 repo 的交易日推算一起失準，屬單點故障。指數單日變動上限是免費的強不變量——成分股各自受 ±10% 限制，加權/櫃買指數在數學上不可能單日動超過 ±10%（FAIL 10.5% / WARN 9%，留給除權息與新股納入）。

**`sector-gain-recalc` 原本規劃在 Tier B，實作放 Tier A**：這條完全不需要外部呼叫（從 `data/daily/*.csv` + `data/exrights.csv` 獨立重算），放 Tier B 等於每天只守一次還不擋 commit；放 Tier A 每次 CI 都守著聚合邏輯，成本不到 0.1 秒。抽成交金額最大的 3 個而非 1 個，deterministic 且結果穩定可比對。

**`exdiv-blank-change-has-ref`**：TWSE 除息日 `漲跌價差` 是 `X`，`fetch_daily` 的 `num()` 吃成 `null` → csv 存空字串；`build_report` 的 fallback 是 `change != null ? close - change : close`，也就是**缺參考價時當日漲幅靜默變 0.00%**，還原鏈那一節也斷。見 llm_wiki: twse-exdiv-change-x-zero-pct。

## `exrights-integrity`：比值超區間也是兩種成因

`ref/前收` 落在 0.5~1.1 之外，同樣有兩種相反的成因：

1. **抓錯欄位／串錯股號**：假參考價跟市場當天實際成交的價位完全對不上，要修 `fetch_exrights.mjs`。
2. **真的大型公司行動**：`exrights.csv` 匯的是四個來源（`TWT49U` 除權息／`TWTAUU` 減資／`TWTB8U` 面額變更／TPEX `revivt`），後三者的參考價本來就會離前收很遠——`TWTB8U` 的 1 拆 4 比值恆為 0.25，單一 0.5~1.1 區間對它們是結構性誤判。

分辨指紋是**除權息當日的成交價**：交易所那天的漲跌停是拿參考價當基準算的，所以真參考價必然被當天成交價圍住（±10%，留 0.5pp 給尾差），抓錯欄位的假參考價不可能對得上。這條佐證零外部呼叫，只讀 `data/daily/<除權息日>.csv`。

佐證得過 → WARN（不擋 commit）；佐證不過、或那天根本沒成交（無從佐證）→ 維持 FAIL。取捨同 `exrights-date-has-daily`：一檔真實公司行動不該把每日 pipeline 永久卡死——這條擋的是 commit，而 fetch 每輪都會重抓同一筆，卡住就是天天紅、資料停更。

WARN 只在**近 5 個交易日內**給。公司行動那筆會永遠留在 `exrights.csv`，不設窗口就是天天黃燈；早於這個窗口的（已被市價佐證過、也看過一輪了）降回 PASS，只在訊息末尾附一句筆數。常態黃燈會稀釋掉真正該看的告警——這個 repo 最怕的失效模式正是「CI 綠燈、資料默默停更」。

實例：2026-08-14 TPEX 5314 前收 61.3 → 參考價 14.75（比值 0.241），是 run #71（`Daily update`）唯一的 FAIL，把當天整批資料擋在 commit 之外。

## `exrights-date-has-daily`：兩種成因，修法相反

除權息日沒有對應 daily 檔，有兩種完全不同的原因：

1. **全市場休市（颱風假）**：`market_index.csv` 同樣沒那天。除權息實際順延到次一交易日——交易所在那天才拿參考價當基準算漲跌。`build_report.mjs` 載入端有順延邏輯，這條只驗「順延得成」。
2. **單日漏抓**：`market_index` 有那天、`daily/` 沒有。這才是真破洞，要 `node scripts/fetch_daily.mjs <日期>`。

分辨指紋就是 `market_index.csv` 有沒有那天。實例：2026-07-10 颱風休市，17 檔的參考價實際在 07-13 生效（3217 前收 173.5 → ref 163.5，交易所 7/13 算的漲跌 −2.14% = 160/163.5−1）；不順延則鏈上得到 −7.78%，整段配息缺口被當成真實下跌。`build_report` 的 ±12% band 只擋得住 −11% 以上的大額（而且是粗暴歸零成「價值中性」，同樣錯），−3%~−8% 的一般配息完整穿過。

順延的三道護欄：原定日在資料範圍內／次一交易日在 5 日曆天內／目標鍵未被占用。詳見 llm_wiki: twse-exdiv-date-postponed-by-closure。

漏抓的嚴重度分級：近 5 個交易日內 FAIL（`--backfill 7` 救得回來，擋 commit 有意義），更早只 WARN（歷史破洞永久擋住每日 commit 會讓資料停更，比原問題更糟）。

## Tier B（3 條，交叉源）

| check-id | 驗什麼 |
|---|---|
| `index-close-vs-twse-website` | 加權指數 close vs twse_website `today.json` |
| `exrights-vs-twse-website` | 本站 exrights 應為 twse_website 的子集（近 370 天） |
| `exrights-chain-gap` | 以上游除權息事件反查本地還原鏈的假跳空 |

`exrights-chain-gap` 原規劃是「純本地抽驗還原鏈連續性」，實作改成拿 twse_website 的 exrights 反查——**純本地無法區分「真實下跌」與「漏抓除息造成的假跳空」**，兩者在資料上長得一模一樣，非得有第二源才驗得出來。判準：對「上游有、本地缺」且本地有行情的 (date,id)，配息幅度 ≥1% 且鏈上報酬與配息幅度吻合 ±1.5pp 即判為假跳空。

外部源掛掉／超時／非 200 一律 SKIP。呼叫上限 3 次、間隔 ≥1.2 秒（`exrights-chain-gap` 重用上一條抓到的 CSV，不額外呼叫）。

## Cross-repo

原規劃的「cross-repo 週檢獨立掛一份」**沒有實作，也不打算做**。三條互驗已分散進各 repo 的 Tier B：指數對帳與 exrights 超集在本 repo，月底收盤在 financial_report。全走 `raw.githubusercontent`，不需 sibling checkout。再獨立開一份等於重複實作同一批比對。

## 沒做的

- **Tier C golden regression**：固定 `data/` 縮樣 → 跑 `build_report.mjs` → diff `docs/report.json`。build_report 是純函數、重跑冪等，適合 golden。這輪刻意沒做。
- **`data/categories.json` 與 CMoney 的一致性**：目前只驗「非空、≥50 分類、無空分類」。`refresh-categories.yml` 每月跑一次，分類漂移屬慢性風險，適合週檢而非日檢。
- **「週間日既無 daily 檔也無 index 列且無除權息」的洞**（真假日 vs 漏抓）目前分不出來，要靠 twse_website 的 `market_calendar` 才能判。

## ⚠️ 未驗證的前提

整套的告警依賴「FAIL → exit 1 → workflow 紅 → GitHub 寄信」。**這條路徑還沒實測過**，不寄信的話這些檢查全是白寫的。
