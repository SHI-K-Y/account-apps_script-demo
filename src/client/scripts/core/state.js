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
    source: '',
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
