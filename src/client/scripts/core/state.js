const AppState = {
  bookkeeping: {
    data: null,
    mutationVersion: 0,
    expense: {
      item: '', category: '生活費', payment: '現金', paid: '', amount: '',
      itemSuggested: false, paymentTouched: false, categoryTouched: false,
    },
    income: { item: '', category: '生活費', amount: '' },
    combo: { id: '', type: 'expense', item: '', category: '', payment: '', paid: '', amount: '' },
    dailyExpenses: {},
    budget: null,
    toastTimer: null,
    recentState: {
      expense: { isFull: false, records: null, fullRecords: null },
      income: { isFull: false, records: null, fullRecords: null },
    },
  },
  editModal: {
    active: false,
    source: '',             // ''（記帳頁）｜'search'｜'creditcard'
    expect: null,           // 開啟時畫面上的內容，寫入前由後端核對（只有信用卡對帳頁帶）
    type: 'expense',
    month: '',
    row: null,
    day: 1,
    item: '',
    category: '',
    payment: '',
    paid: '',
    amount: '',
    note: '',
  },
  deleteModal: {
    active: false,
    source: '',
    expect: null,
    type: 'expense',
    month: '',
    row: null,
    record: null,
  },
  settlement: {
    year: null,
    month: null,
    loaded: false,
  },
  settings: {
    currentTab: 'expenseItems',
    paySubtab: 'cards',
    addPosition: 'bottom',
    addFormOpen: false,
    data: null,
    metadata: null,
    loading: false,
    loaded: false,
    selectedIcon: 'egg',
    editingCardId: null,
    editingChannelName: null,
    editingBankId: null,
    editingItemRow: null,
    editingItemCategory: null,
    deleteTarget: null
  },
  creditCard: {
    selectedCard: 'ALL',
    selectedMonth: 'ALL',   // 'ALL' 或月份工作表名稱（例如 '2026.11'）
    statusFilter: 'all',
    recordsByMonth: {},
    skippedMonths: {},
    staleMonths: {},        // 寫入後合併不了、下次要重新讀取的月份（不能用本機快取）
    lockedMonths: {},       // 有修改／刪除／復原正在寫入的月份（值是件數）：列號可能位移，先不接受其他操作
    loadingProgress: null,
    loading: false,
    busyRows: {},
    batchBusy: false,
  },
  foreign: {
    view: 'list',
    ledgers: [],
    ledgersLoaded: false,
    currentId: null,
    dataById: {},
    tab: 'entry',
    form: { date: '', item: '', payment: '', currency: '', amount: '', rate: null, rateManual: false, note: '' },
    filter: 'all',
    pending: [],
  }
};

const state = AppState.bookkeeping;
const editState = AppState.editModal;
const deleteState = AppState.deleteModal;
const stCalState = AppState.settlement;
const settingsState = AppState.settings;
const ccState = AppState.creditCard;
const fxState = AppState.foreign;
