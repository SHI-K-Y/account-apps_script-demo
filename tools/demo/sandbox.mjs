// Demo 沙盒後端：在記憶體裡執行「真正的後端程式」（dist/code.gs），資料是虛構的範例活頁簿。
// 沒有任何網路連線，也不會碰到 Google 試算表；丟掉這個物件（重新整理頁面）資料就還原。
// 不依賴 Node 專用 API：瀏覽器（公開 Demo）與 Node（自動化測試）共用同一份。
import { createGasRuntime } from '../gas-mock/runtime.mjs';
import { createRecalc } from './recalc.mjs';
import { createDemoWorkbook } from './demo-data.mjs';

const BACKEND_OFFSET_MINUTES = 480; // 後端固定以 Asia/Taipei 判斷「今天」

/**
 * @param {object} opts
 *   serverSource        後端原始碼（dist/code.gs 的內容）
 *   clock               選用：回傳目前時間（毫秒）的函式，預設 Date.now
 *   localOffsetMinutes  選用：訪客所在時區與 UTC 的差距（分鐘，東邊為正），預設取自瀏覽器
 *   log                 選用：後端 console / Logger 的輸出
 */
export function createDemoBackend(opts) {
  const options = opts || {};
  const clock = options.clock || (() => Date.now());
  const localOffset = options.localOffsetMinutes == null ? -new Date(clock()).getTimezoneOffset() : options.localOffsetMinutes;

  // 前端用訪客當地的日期當「今天」，後端則固定用台北時區。把後端看到的「現在」平移一下，
  // 讓兩邊在任何時區都落在同一天、同一個月（Date.now() 維持真實時間，快取時間戳記才能互相比較）。
  const shiftMs = (localOffset - BACKEND_OFFSET_MINUTES) * 60000;
  class DemoDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(clock() + shiftMs);
      else super(...args);
    }
    static now() { return clock(); }
  }

  const local = new Date(clock() + localOffset * 60000);
  const today = { y: local.getUTCFullYear(), m: local.getUTCMonth() + 1, d: local.getUTCDate() };
  const demo = createDemoWorkbook(today);

  const runtime = createGasRuntime({
    workbook: demo.workbook,
    properties: demo.properties,
    recalc: createRecalc({ opening: demo.opening }),
    DateCtor: DemoDate,
    files: {},
    log: options.log || (() => {}),
  });
  const fns = runtime.load(options.serverSource);
  fns.setup();

  const clone = value => (value === undefined ? null : JSON.parse(JSON.stringify(value)));

  return {
    today,
    runtime,
    /** 與 google.script.run 相同的規則：只能呼叫名稱不以底線結尾的頂層函式；參數與回傳值都會經過序列化。 */
    invoke(name, args) {
      const fn = fns[name];
      if (typeof fn !== 'function' || /_$/.test(name) || name === '__eval') {
        const err = new Error('找不到指令碼函式：' + name);
        err.name = 'ScriptError';
        throw err;
      }
      return clone(fn.apply(null, clone(args || [])));
    },
    /** 經由 API 閘道呼叫（與前端相同的路徑）。 */
    call(action, ...args) {
      return this.invoke('api', [{ action, args }]);
    },
    /** 頁面載入時直接內嵌的啟動資料（等同 doGet 範本裡的 initialDataJson）。 */
    initialData() {
      return this.call('getInitialData', true);
    },
  };
}
