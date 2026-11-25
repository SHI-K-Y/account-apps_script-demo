const CONFIG = Object.freeze({
  SETTINGS_SHEET: '資料選單設定區',
  OPTION_SHEET: '資料選單設定區',
  TEMPLATE_SHEET: '新版記帳簿空白頁',
  SUMMARY_SHEET: '_月份彙總',
  BUDGET_SHEET: '_預算設定',
  // 淨資產快照（F06）：過完的月份一列一個月，由每日維護觸發器寫入（34_net_worth.gs）
  NET_WORTH_SHEET: '_資產快照',
  SETTLEMENT_SHEETS: Object.freeze(['對帳系統', '結帳系統']),
  MIN_DATA_ROW: 5,
  MAX_DATA_ROW: 1004,
  MONTH_PATTERN: /^\d{4}\.\d{2}$/,
  FX_PREFIX: '國外交易記帳簿-',
  FX_TEMPLATE_SHEET: '國外交易記帳簿-空白頁',
  FX_MIN_DATA_ROW: 3,
  FX_MAX_DATA_ROW: 1000,
  CACHE_TTL: 21600,
  CACHE_KEYS: Object.freeze({
    BOOT_JSON: 'BOOT_INIT_JSON_V2',
    MONTHS_LIST: 'MONTHS_LIST_V2',
    OPTIONS_ALL: 'OPTIONS_ALL_V3',
    // 記帳驗證用的簡易選項（P10）：只有 OPTIONS_ALL 的 simple 部分，一般 JSON（不壓縮），寫入時不用解整份 OPTIONS_ALL
    OPTIONS_SIMPLE: 'OPTIONS_SIMPLE_V1',
    MONTH_DATA_PREFIX: 'MONTH_DATA_V2_',
    OVERVIEW_PREFIX: 'OVERVIEW_V3_',
    SETTLEMENT_PREFIX: 'SETTLEMENT_V2_',
    CHARTS_PREFIX: 'CHARTS_V2_',
    SHEET_LAYOUT_PREFIX: 'SHEET_LAYOUT_V1_',
    FX_LEDGERS: 'FX_LEDGERS_V1',
    FX_LEDGER_PREFIX: 'FX_LEDGER_V1_',
    FX_RATES_PREFIX: 'FX_RATES_V1_',
    BUDGET_CONFIG: 'BUDGET_CONFIG_V1',
    BUDGET_OPENING_PREFIX: 'BUDGET_OPENING_V1_',
    // 淨資產歷史（F06）：過完的月份（本月用 OVERVIEW）；與「快照從哪個月起過期」的指令碼屬性鏡像
    NET_WORTH: 'NET_WORTH_V1',
    NET_WORTH_DIRTY_MARK: 'NET_WORTH_DIRTY_MARK_V1',
    // 月底預估（F06）：本月的前三個月的精簡支出明細，鍵是本月
    FORECAST_HISTORY_PREFIX: 'FORECAST_HISTORY_V1_',
    DOGET_CONFIG: 'DOGET_CONFIG_V1',
    // 試算表 ID（P10）：指令碼屬性 SPREADSHEET_ID 的快取，寫入時和選項一起一次 getAll 讀回，不用每次讀屬性
    SPREADSHEET_ID: 'SPREADSHEET_ID_V1',
    // 已標記「月份彙總需要重建」的月份（P10）：指令碼屬性 SUMMARY_DIRTY 的鏡像，已標記的月份不用再讀寫屬性
    SUMMARY_DIRTY_MARKS: 'SUMMARY_DIRTY_MARKS_V1',
    // doGet 上次把啟動資料寫進指令碼屬性備援快照（BOOT_SNAPSHOT）的時間（P10）
    BOOT_SNAPSHOT_STAMP: 'BOOT_SNAPSHOT_STAMP_V1',
    // 冪等：寫入操作的結果存在「OP_<opId>」，同一個 opId 重送時直接回傳（P10）
    OP_PREFIX: 'OP_',
  }),
  // 冪等結果保存多久（秒）：前端自動重試與離線佇列重送都在這段時間內
  OP_RESULT_TTL: 21600,
  // doGet 最多多久更新一次指令碼屬性的啟動資料快照（毫秒）
  BOOT_SNAPSHOT_INTERVAL_MS: 30 * 60 * 1000,
  // doGet 用的設定快取（允許名單、App 圖示、網址）存多久：指令碼屬性改了之後，最慢這麼久生效（執行 setup() 立即生效）。
  DOGET_CONFIG_TTL: 3600,
  PROP_KEYS: Object.freeze({
    SPREADSHEET_ID: 'SPREADSHEET_ID',
    BOOT_SNAPSHOT: 'BOOT_SNAPSHOT_V2',
    OPTIONS_SNAPSHOT: 'OPTIONS_SNAPSHOT_V2',
    MONTHS_SNAPSHOT: 'MONTHS_SNAPSHOT_V2',
    SETTINGS_METADATA: 'SETTINGS_METADATA_V2',
    SUMMARY_DIRTY: 'SUMMARY_DIRTY_V1',
    // 淨資產快照從哪個月起過期（最早被改到的過去月份，F06）
    NET_WORTH_DIRTY: 'NET_WORTH_DIRTY_V1',
    FX_LEDGER_IDS: 'FX_LEDGER_IDS_V1',
    // 舊版存在試算表 O1:Q1 的 metadata 已清掉（P11）：之後讀 metadata 不用再開試算表檢查
    LEGACY_META_CLEANED: 'LEGACY_META_CLEANED',
    // 目前存了哪些卡片／銀行圖片屬性（JSON 陣列，P11）：讀 metadata 時只讀需要的圖片，不用 getProperties()
    SETTINGS_IMAGE_INDEX: 'SETTINGS_IMAGE_INDEX_V1',
  }),
  // 預熱觸發器（P11，見 12_warm.gs）：多久跑一次，以及它寫入 doGet 設定快取時用的存活時間
  // （比間隔多 15 分鐘，下一次預熱前不會過期；指令碼屬性改了之後最慢這麼久生效，執行 setup() 立即生效）
  WARM_INTERVAL_HOURS: 2,
  WARM_DOGET_CONFIG_TTL: 2 * 3600 + 15 * 60,
});

const SETTINGS_CATEGORY_COLUMNS_ = Object.freeze({
  expenseItems: 2,
  incomeItems: 3,
  expenseCategories: 4,
  incomeCategories: 5,
  paymentMethods: 6,
});
