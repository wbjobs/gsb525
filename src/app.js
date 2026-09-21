import { createBroadcastBus } from "./bus.js";
import { COLUMNS, comparePositions, getCardsByColumn, getLiveCards } from "./crdt.js";
import { initPointerDrag } from "./drag.js";
import { createIdbStorage, openDatabase } from "./storage.js";
import { createBoardStore } from "./store.js";

const boardElement = document.querySelector("#board");
const connectionDot = document.querySelector("#connection-dot");
const connectionText = document.querySelector("#connection-text");
const connectionToggle = document.querySelector("#connection-toggle");
const peerCountElement = document.querySelector("#peer-count");
const latencyElement = document.querySelector("#sync-latency");
const pendingElement = document.querySelector("#pending-count");
const editDialog = document.querySelector("#edit-dialog");
const editForm = document.querySelector("#edit-form");
const editTitle = document.querySelector("#edit-title");
const editDescription = document.querySelector("#edit-description");

let store;
let editingCardId = null;
let dragController;

dragController = initPointerDrag(boardElement, handleDrop);

function createCardElement(card) {
  const cardElement = document.createElement("article");
  cardElement.className = "card";
  cardElement.dataset.cardId = card.id;
  if (dragController.getDraggingCardId() === card.id) {
    cardElement.dataset.dragging = "true";
  }

  const titleElement = document.createElement("h3");
  titleElement.className = "card-title";
  titleElement.textContent = card.title;

  const descriptionElement = document.createElement("p");
  descriptionElement.className = "card-description";
  descriptionElement.textContent = card.description || "无描述";

  const actionsElement = document.createElement("div");
  actionsElement.className = "card-actions";

  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.className = "icon-button";
  editButton.textContent = "编辑";
  editButton.addEventListener("click", () => openEditDialog(card.id));

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "icon-button danger";
  deleteButton.textContent = "删除";
  deleteButton.addEventListener("click", () => {
    if (window.confirm("删除后将通过 CRDT 墓碑同步到所有标签页，确定继续吗？")) {
      void store.deleteCard(card.id);
    }
  });

  actionsElement.append(editButton, deleteButton);
  cardElement.append(titleElement, descriptionElement, actionsElement);
  return cardElement;
}

function createColumn(column, cards) {
  const columnElement = document.createElement("section");
  columnElement.className = "column";
  columnElement.dataset.columnId = column.id;

  const header = document.createElement("header");
  header.className = "column-header";
  const title = document.createElement("h2");
  title.textContent = column.title;
  const count = document.createElement("span");
  count.textContent = `${cards.length} 张卡片`;
  header.append(title, count);

  const list = document.createElement("div");
  list.className = "card-list";
  for (const card of cards) list.append(createCardElement(card));

  const form = document.createElement("form");
  form.className = "add-form";
  const input = document.createElement("input");
  input.placeholder = "新卡片标题";
  input.maxLength = 120;
  input.setAttribute("aria-label", `在${column.title}中添加卡片`);
  const addButton = document.createElement("button");
  addButton.type = "submit";
  addButton.textContent = "添加";

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const title = input.value.trim();
    if (!title) return;
    input.value = "";
    void store.addCard(column.id, title);
  });

  form.append(input, addButton);
  columnElement.append(header, list, form);
  return columnElement;
}

function render() {
  const snapshot = store.getSnapshot();
  const cardsByColumn = getCardsByColumn(snapshot.state);
  const fragment = document.createDocumentFragment();

  for (const column of COLUMNS) {
    fragment.append(createColumn(column, cardsByColumn.get(column.id) ?? []));
  }

  boardElement.replaceChildren(fragment);
  renderStatus();
}

function renderStatus() {
  const snapshot = store.getSnapshot();
  connectionDot.classList.toggle("online", snapshot.connected);
  connectionDot.classList.toggle("offline", !snapshot.connected);
  connectionText.textContent = snapshot.connected ? "在线" : "同步已暂停";
  connectionToggle.textContent = snapshot.connected ? "断开连接" : "恢复同步";
  peerCountElement.textContent = `${snapshot.peers} 个其他标签页`;
  latencyElement.textContent = `同步 ${snapshot.latency === null ? "--" : snapshot.latency} ms`;
  pendingElement.textContent = `待同步 ${snapshot.pending}`;
}

function openEditDialog(cardId) {
  const card = store.getState().cards.get(cardId);
  if (!card || card.deleted) return;
  editingCardId = cardId;
  editTitle.value = card.title;
  editDescription.value = card.description;
  editDialog.returnValue = "";
  editDialog.showModal();
}

editForm.addEventListener("submit", (event) => {
  if (event.submitter?.value !== "save") return;
  event.preventDefault();
  const title = editTitle.value.trim();
  if (!title || !editingCardId) return;
  void store
    .updateCard(editingCardId, title, editDescription.value.trim())
    .then(() => editDialog.close());
});

editDialog.addEventListener("close", () => {
  editingCardId = null;
});

function handleDrop(cardId, columnId, targetIndex) {
  const state = store.getState();
  const card = state.cards.get(cardId);
  if (!card || card.deleted) return;

  const columnCards = getLiveCards(state)
    .filter((item) => item.columnId === columnId)
    .sort((left, right) => comparePositions(left.position, right.position));
  const currentIndex = columnCards.findIndex((item) => item.id === cardId);

  if (card.columnId === columnId && currentIndex === targetIndex) return;

  void store.moveCard(cardId, columnId, targetIndex);
}

connectionToggle.addEventListener("click", () => {
  const snapshot = store.getSnapshot();
  store.setConnected(!snapshot.connected);
});

window.addEventListener("online", () => store.setConnected(true));
window.addEventListener("offline", () => store.setConnected(false));

async function boot() {
  const database = await openDatabase();
  const storage = createIdbStorage(database);
  const bus = createBroadcastBus();
  store = createBoardStore({ storage, bus });

  store.subscribe((event) => {
    if (event.type === "state") render();
    if (event.type === "status") renderStatus();
  });

  await store.start();
  render();

  window.setInterval(() => store.heartbeat(), 2000);

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
  }
}

boot().catch((error) => {
  console.error(error);
  boardElement.replaceChildren(document.createTextNode(`启动失败：${error.message}`));
});
