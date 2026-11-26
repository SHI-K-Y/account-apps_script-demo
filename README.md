# 記帳簿

用 Google 試算表當資料庫的個人記帳網頁：Google Apps Script（後端）＋ HtmlService 網頁（前端）。
手機上三秒記一筆，資料留在你自己的 Google 試算表裡。

**線上試用：<https://shi-k-y.github.io/account-apps_script-demo/>**

## 線上 Demo

Demo 是純前端的沙盒版本，不需要登入、也不會連到任何試算表：

- 內建一本**完全虛構**的範例帳簿（最近六個月的收支、三張卡片、一趟旅行），金額、備註、銀行與卡片名稱都是編出來的。
- 可以自由新增、修改、刪除紀錄，總覽、圖表、對帳數字都會跟著變。
- 所有資料只存在你這個瀏覽器分頁的記憶體裡，**重新整理就還原**（或按左下角 DEMO 標籤的「還原」）。

### Demo 怎麼運作

正式版的後端程式跑在 Google Apps Script 上、讀寫 Google 試算表。Demo 把同一份後端程式（`dist/code.gs`）
連同一個模擬的 Apps Script 環境（`tools/gas-mock/`）一起打包進網頁，在瀏覽器裡執行；
前端呼叫的 `google.script.run` 也換成直接呼叫記憶體裡的後端。所以 Demo 的行為與正式版相同，只是沒有真實的儲存空間。

| 檔案 | 用途 |
| --- | --- |
| `tools/demo/build-demo.mjs` | 把專案打包成單一靜態網頁 `docs/index.html` |
| `tools/demo/sandbox.mjs`、`sandbox-entry.mjs` | 瀏覽器裡的沙盒後端與 `google.script.run` 替身 |
| `tools/demo/demo-data.mjs` | 虛構的範例資料（依當天日期產生最近六個月） |
| `tools/demo/recalc.mjs` | 用程式重現試算表公式（總覽、對帳、換算台幣） |
| `docs/` | 建置好的 Demo 網站，GitHub Pages 直接提供這個資料夾 |

## 在自己的電腦上執行

需要 Node.js 22 以上（`package.json` 的 `engines`）。

```
npm install
npx playwright install chromium   # 第一次跑測試前執行：下載瀏覽器測試用的 Chromium
npm run preview:demo     # 建置 Demo 並開啟 http://localhost:8090
npm run dev              # 開發模式 http://localhost:8080（存檔自動重新建置，使用內建的測試資料）
npm test                 # 自動化測試（tools/run-tests.mjs 列出 tools/test/*.test.mjs 交給 node --test）
```

沒有 Chromium 時，用瀏覽器的測試會顯示 skipped，其餘照常執行；設定 `REQUIRE_BROWSER=1` 則改為直接失敗。

## 用在自己的 Google 試算表

1. 準備一份版面相同的試算表（月份工作表名稱像 `2026.11`，另有「資料選單設定區」「對帳系統」「新版記帳簿空白頁」等工作表；
   欄位配置可參考 `tools/gas-mock/fixture.mjs`）。
2. `npm run build` 產生 `dist/`。
3. 開啟試算表 →「擴充功能 → Apps Script」，把 `dist/` 裡的 `code.gs`、`Index.html`、`style.html`、`app.html`、`assets.html`
   貼到同名的檔案；或用 clasp：複製 `.clasp.json.example` 為 `.clasp.json`、填入專案 ID 後執行 `npm run deploy`。
4. 在編輯器執行一次 `setup`，再「部署 → 新增部署作業 → 網頁應用程式」。建議存取權設為「只有我自己」。

選用的存取控制（指令碼屬性 `ALLOWED_EMAILS`、`API_TOKEN`、`API_READ_TOKEN`）說明在 `src/server/04_auth.gs`。

## 專案結構

```
src/server/      後端（Apps Script），依檔名順序串接成 dist/code.gs
src/client/      前端：頁面骨架、樣式、程式（載入順序登記在 manifest.json）
tools/build.mjs  建置：src/ → dist/
tools/gas-mock/  模擬的 Apps Script 環境（本機預覽、測試、Demo 共用）
tools/demo/      Demo 網站的建置與沙盒
tools/test/      自動化測試
docs/            建置好的 Demo 網站（GitHub Pages）
```

## 關於這個 Repo

這裡的內容是從作者私下維護的主專案自動同步過來的：同步時會移除所有個人資料，
並把預設的銀行、卡片換成虛構的名稱與圖案。請不要直接在這裡修改 `src/`、`tools/`、`docs/`，下次同步會被覆蓋。
