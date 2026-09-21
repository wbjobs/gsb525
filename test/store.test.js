import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryBus } from "../src/bus.js";
import { createMemoryStorage } from "../src/storage.js";
import { createBoardStore } from "../src/store.js";

const delay = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

function createTimers(start = 1000) {
  let value = start;
  return {
    next: () => (value += 1),
    get value() {
      return value;
    }
  };
}

function hexSite(char) {
  return char.repeat(32);
}

async function createPeers(count, storage, bus) {
  const timers = Array.from({ length: count }, () => createTimers(1000));
  const stores = [];
  for (let index = 0; index < count; index += 1) {
    stores.push(
      createBoardStore({
        storage,
        bus: bus.makeBus(),
        siteId: hexSite(String.fromCharCode(97 + index)),
        now: () => timers[index].value,
        randomValue: () => 0.5
      })
    );
  }
  for (const board of stores) await board.start();
  await delay(20);
  return { stores, timers };
}

function cardState(store, cardId) {
  const card = store.getState().cards.get(cardId);
  return {
    title: card.title,
    description: card.description,
    columnId: card.columnId,
    deleted: card.deleted,
    position: JSON.stringify(card.position),
    movedAt: card.movedAt,
    contentAt: card.contentAt
  };
}

test("four tabs synchronize a locally added card", async () => {
  const bus = createMemoryBus();
  const storage = createMemoryStorage();
  const { stores } = await createPeers(4, storage, bus);

  await stores[0].addCard("done", "four-tab-card");
  await delay(30);

  for (const store of stores) {
    assert.equal(store.getOperations().length, stores[0].getOperations().length);
    assert.ok([...store.getState().cards.values()].some((card) => card.title === "four-tab-card"));
  }
});

test("synchronization latency stays below the 200 ms acceptance threshold", async () => {
  const bus = createMemoryBus();
  const storage = createMemoryStorage();
  const timers = Array.from({ length: 4 }, (_, index) => createTimers(2000 + index));
  const stores = [];
  for (let index = 0; index < 4; index += 1) {
    stores.push(
      createBoardStore({
        storage,
        bus: bus.makeBus(),
        siteId: hexSite(String.fromCharCode(97 + index)),
        now: () => timers[index].value,
        randomValue: () => 0.5
      })
    );
  }
  for (const store of stores) await store.start();
  await delay(30);

  await stores[0].addCard("done", "latency-card");
  await delay(30);

  const latencies = stores.slice(1).map((store) => store.getSnapshot().latency).filter((value) => value !== null);
  assert.ok(latencies.length >= 3, `expected at least 3 latency samples, got ${latencies.length}`);
  for (const latency of latencies) assert.ok(latency < 200, `latency ${latency} exceeded 200 ms`);
});

test("two tabs dragging the same card converge to one deterministic winner", async () => {
  const bus = createMemoryBus();
  const storage = createMemoryStorage();
  const { stores } = await createPeers(2, storage, bus);
  const cardId = "seed-card-4";

  stores[0].setConnected(false);
  stores[1].setConnected(false);
  await stores[0].moveCard(cardId, "done", 0);
  await stores[1].moveCard(cardId, "ready", 0);

  stores[0].setConnected(true);
  stores[1].setConnected(true);
  await delay(40);

  const first = cardState(stores[0], cardId);
  const second = cardState(stores[1], cardId);
  assert.deepEqual(second, first);
  assert.equal(first.movedAt.slice(-1), "b");
  assert.equal(first.columnId, "ready");
});

test("offline add, edit, move, and delete merge correctly after reconnect", async () => {
  const bus = createMemoryBus();
  const storage = createMemoryStorage();
  const { stores } = await createPeers(3, storage, bus);
  const deletedCardId = "seed-card-1";

  stores[1].setConnected(false);
  await stores[0].addCard("backlog", "online-card");
  await stores[1].addCard("ready", "offline-card");
  await stores[1].updateCard("seed-card-3", "offline edited", "merged description");
  await stores[1].moveCard("seed-card-2", "doing", 0);
  await stores[1].deleteCard(deletedCardId);
  await delay(10);

  assert.equal(stores[0].getState().cards.has("offline-card"), false);
  stores[1].setConnected(true);
  await delay(50);

  for (const store of stores) {
    const operationIds = new Set(store.getOperations().map((operation) => operation.id));
    assert.equal(operationIds.size, stores[0].getOperations().length);
    assert.ok([...store.getState().cards.values()].some((card) => card.title === "online-card"));
    assert.ok([...store.getState().cards.values()].some((card) => card.title === "offline-card"));
    assert.equal(store.getState().cards.get("seed-card-3").title, "offline edited");
    assert.equal(store.getState().cards.get("seed-card-2").columnId, "doing");
    assert.equal(store.getState().cards.get(deletedCardId).deleted, true);
  }
});

test("concurrent edit and delete keep the deleted card tombstoned", async () => {
  const bus = createMemoryBus();
  const storage = createMemoryStorage();
  const { stores } = await createPeers(2, storage, bus);
  const cardId = "seed-card-5";

  stores[0].setConnected(false);
  stores[1].setConnected(false);
  await stores[0].updateCard(cardId, "edited while deleted", "");
  await stores[1].deleteCard(cardId);

  stores[0].setConnected(true);
  stores[1].setConnected(true);
  await delay(40);

  for (const store of stores) {
    assert.equal(store.getState().cards.get(cardId).deleted, true);
  }
});

test("reloading from IndexedDB-compatible storage does not lose operations", async () => {
  const bus = createMemoryBus();
  const storage = createMemoryStorage();
  const initial = await createPeers(1, storage, bus);
  await initial.stores[0].addCard("done", "persisted-card");
  await delay(10);

  const restartBus = createMemoryBus();
  const restarted = createBoardStore({
    storage,
    bus: restartBus.makeBus(),
    siteId: hexSite("e"),
    now: createTimers(5000).next,
    randomValue: () => 0.5
  });
  await restarted.start();

  assert.ok([...restarted.getState().cards.values()].some((card) => card.title === "persisted-card"));
});
