/*
 * app.js — 看板 UI / 拖拽 / 同步 / 持久化
 * 技术栈：BroadcastChannel（实时同步）+ IndexedDB（op 日志持久化）
 *        + Pointer Events（拖拽）+ CRDT（crdt.js，冲突合并）
 */
'use strict';

const { KanbanCRDT } = window.KanbanCRDT;
const { SyncEngine } = window.KanbanSync;

const COLUMNS = [
  { id: 'todo', name: '待办' },
  { id: 'doing', name: '进行中' },
  { id: 'done', name: '已完成' },
];
const COL_IDS = COLUMNS.map(c => c.id);

/* ---------- 标签页身份（sessionStorage：刷新保留，新标签页新身份） ---------- */
let clientId = sessionStorage.getItem('kanban-client-id');
if (!clientId) {
  clientId = 'tab-' + Math.random().toString(36).slice(2, 8);
  sessionStorage.setItem('kanban-client-id', clientId);
}
document.getElementById('tabId').textContent = clientId;

const crdt = new KanbanCRDT(clientId);

/* ---------- IndexedDB：op 日志（刷新不丢数据、离线合并的公共存储） ---------- */
const DB_NAME = 'kanban-crdt';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('ops', { keyPath: 'opId' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
// SyncEngine 的 store 适配器
function idbStore(db) {
  return {
    put: (op) => new Promise((resolve, reject) => {
      const tx = db.transaction('ops', 'readwrite');
      tx.objectStore('ops').put(op);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    }),
    getAll: () => new Promise((resolve, reject) => {
      const tx = db.transaction('ops', 'readonly');
      const req = tx.objectStore('ops').getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }),
  };
}

/* ---------- 在线状态与离线队列 ---------- */
let forcedOffline = false;

function isOnline() {
  return !forcedOffline && navigator.onLine;
}

function updateNetUI() {
  const el = document.getElementById('netStatus');
  const btn = document.getElementById('offlineBtn');
  const online = isOnline();
  el.textContent = online ? '在线' : '离线（操作已本地保存）';
  el.className = 'badge ' + (online ? 'online' : 'offline');
  btn.textContent = forcedOffline ? '恢复在线' : '模拟离线';
  btn.classList.toggle('active', forcedOffline);
}

/* ---------- BroadcastChannel 实时同步 + 同步引擎 ---------- */
const channel = new BroadcastChannel('kanban-sync');
let maxLatency = 0;

const sync = new SyncEngine({
  crdt,
  store: null, // init 时注入
  channel,
  isOnline,
  onChange: () => render(),
  onLatency: (ms) => {
    maxLatency = Math.max(maxLatency, ms);
    document.getElementById('latency').textContent =
      `同步延迟: ${ms}ms（峰值 ${maxLatency}ms）`;
  },
});
const commit = (op) => sync.commit(op);
const resync = () => sync.resync().then(updateNetUI);

document.getElementById('offlineBtn').addEventListener('click', () => {
  forcedOffline = !forcedOffline;
  if (!forcedOffline) resync(); else updateNetUI();
});
window.addEventListener('online', resync);
window.addEventListener('offline', updateNetUI);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && isOnline()) resync(); // 切回标签页时兜底合并
});

/* ---------- 渲染 ---------- */
const board = document.getElementById('board');
let state = null; // 最近一次物化视图（拖拽时用于取邻居 key）

function render() {
  state = crdt.getState(COL_IDS);
  board.innerHTML = '';
  for (const col of COLUMNS) {
    const colEl = document.createElement('section');
    colEl.className = 'column';
    colEl.dataset.column = col.id;

    const h2 = document.createElement('h2');
    h2.textContent = `${col.name} · ${state[col.id].length}`;
    colEl.appendChild(h2);

    const cardsEl = document.createElement('div');
    cardsEl.className = 'cards';
    cardsEl.dataset.column = col.id;
    for (const card of state[col.id]) {
      cardsEl.appendChild(renderCard(card));
    }
    colEl.appendChild(cardsEl);

    const addBtn = document.createElement('button');
    addBtn.className = 'add-btn';
    addBtn.textContent = '＋ 添加卡片';
    addBtn.addEventListener('click', () => openEditor(null, col.id));
    colEl.appendChild(addBtn);

    board.appendChild(colEl);
  }
}

function renderCard(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.cardId = card.id;
  el.dataset.key = card.key;

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = card.title;
  el.appendChild(title);

  if (card.desc) {
    const desc = document.createElement('div');
    desc.className = 'desc';
    desc.textContent = card.desc;
    el.appendChild(desc);
  }

  const del = document.createElement('button');
  del.className = 'del';
  del.textContent = '×';
  del.title = '删除';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    commit(crdt.deleteCard(card.id));
  });
  el.appendChild(del);

  el.addEventListener('dblclick', () => {
    if (Date.now() - lastDragEnd < 300) return; // 拖拽刚结束，忽略
    openEditor(card, card.column);
  });
  el.addEventListener('pointerdown', onDragStart);
  return el;
}

/* ---------- 编辑弹窗（新增 / 编辑共用） ---------- */
const dialog = document.getElementById('editDialog');
const editTitle = document.getElementById('editTitle');
const editDesc = document.getElementById('editDesc');
let editing = null; // { card } 或 { column }（新增）

function openEditor(card, column) {
  editing = card ? { card } : { column };
  dialog.querySelector('h3').textContent = card ? '编辑卡片' : '新建卡片';
  editTitle.value = card ? card.title : '';
  editDesc.value = card ? card.desc : '';
  dialog.showModal();
  editTitle.focus();
}
document.getElementById('editCancel').addEventListener('click', () => dialog.close());
document.getElementById('editSave').addEventListener('click', () => {
  const title = editTitle.value.trim();
  if (!title) { editTitle.focus(); return; }
  const desc = editDesc.value.trim();
  if (editing.card) {
    commit(crdt.editCard(editing.card.id, title, desc));
  } else {
    const cards = state[editing.column];
    const afterKey = cards.length ? cards[cards.length - 1].key : null;
    const cardId = 'card-' + Math.random().toString(36).slice(2, 10);
    commit(crdt.addCard(cardId, title, desc, editing.column, null, afterKey));
  }
  dialog.close();
});

/* ---------- Pointer Events 拖拽（排序 + 跨列移动） ---------- */
let drag = null;       // { cardId, el, startX, startY, active, indicator }
let lastDragEnd = 0;

function onDragStart(e) {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  if (e.target.closest('.del')) return;
  const el = e.currentTarget;
  drag = {
    cardId: el.dataset.cardId, el,
    startX: e.clientX, startY: e.clientY,
    active: false, indicator: null,
  };
  document.addEventListener('pointermove', onDragMove);
  document.addEventListener('pointerup', onDragEnd, { once: true });
  document.addEventListener('pointercancel', onDragCancel, { once: true });
}

function onDragMove(e) {
  if (!drag) return;
  if (!drag.active) {
    if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 5) return;
    drag.active = true;
    drag.el.classList.add('dragging');
    drag.indicator = document.createElement('div');
    drag.indicator.className = 'drop-indicator';
  }
  e.preventDefault();
  positionIndicator(e.clientX, e.clientY);
}

function positionIndicator(x, y) {
  const { indicator, el: dragEl } = drag;
  const target = document.elementFromPoint(x, y);
  const cardsEl = target && target.closest('.cards');
  if (!cardsEl) { indicator.remove(); return; }

  const overCard = target.closest('.card');
  if (overCard && overCard !== dragEl) {
    const rect = overCard.getBoundingClientRect();
    const before = y < rect.top + rect.height / 2;
    cardsEl.insertBefore(indicator, before ? overCard : overCard.nextSibling);
  } else {
    // 空白区域：放到该列末尾（若悬停的是拖拽卡本身附近则保持原位）
    cardsEl.appendChild(indicator);
  }
}

function onDragEnd(e) {
  cleanupDragListeners();
  if (!drag) return;
  const { cardId, el, active, indicator } = drag;
  el.classList.remove('dragging');
  lastDragEnd = Date.now();

  if (active && indicator && indicator.isConnected) {
    const cardsEl = indicator.parentElement;
    const column = cardsEl.dataset.column;
    // 由指示器位置计算前后邻居 key
    let beforeKey = null, afterKey = null;
    const prev = prevCard(indicator);
    const next = nextCard(indicator);
    if (prev) beforeKey = prev.dataset.key;
    if (next) afterKey = next.dataset.key;
    indicator.remove();
    // 位置无变化则不发 op
    const cur = findCard(cardId);
    if (cur && (cur.column !== column || !isSamePosition(cardsEl, cardId, prev, next))) {
      commit(crdt.moveCard(cardId, column, beforeKey, afterKey));
    }
  } else if (indicator) {
    indicator.remove();
  }
  drag = null;
}

function onDragCancel() {
  cleanupDragListeners();
  if (drag) {
    drag.el.classList.remove('dragging');
    if (drag.indicator) drag.indicator.remove();
    drag = null;
  }
}

function cleanupDragListeners() {
  document.removeEventListener('pointermove', onDragMove);
}

function prevCard(el) {
  let n = el.previousElementSibling;
  while (n && !n.classList.contains('card')) n = n.previousElementSibling;
  return n;
}
function nextCard(el) {
  let n = el.nextElementSibling;
  while (n && !n.classList.contains('card')) n = n.nextElementSibling;
  return n;
}
function findCard(cardId) {
  for (const col of COL_IDS) {
    const c = state[col].find(c => c.id === cardId);
    if (c) return c;
  }
  return null;
}
// 指示器前后邻居与卡片当前邻居一致 → 未移动
function isSamePosition(cardsEl, cardId, prev, next) {
  const self = cardsEl.querySelector(`[data-card-id="${cardId}"]`);
  if (!self) return false;
  return prevCard(self) === prev && nextCard(self) === next;
}

/* ---------- 启动 ---------- */
(async function init() {
  sync.store = idbStore(await openDB());
  const opCount = await sync.init(); // 刷新恢复：重放 op 日志

  if (opCount === 0) { // 首次使用：写入示例数据
    const seed = [
      ['欢迎使用协同看板', '双击可编辑我', 'todo'],
      ['拖拽我试试', '支持排序和跨列移动', 'todo'],
      ['多开几个标签页', '所有操作实时同步', 'doing'],
    ];
    for (const [t, d, col] of seed) {
      const cards = crdt.getState(COL_IDS)[col];
      const afterKey = cards.length ? cards[cards.length - 1].key : null;
      await commit(crdt.addCard('card-' + Math.random().toString(36).slice(2, 10), t, d, col, null, afterKey));
    }
  }
  render();
  updateNetUI();
})();
