import assert from "node:assert/strict";
import test from "node:test";

import {
  compareHLC,
  comparePositions,
  createHLC,
  createInitialState,
  getLiveCards,
  mergeOperations,
  positionBetween,
  reduceOperation
} from "../src/crdt.js";

function serializeState(state) {
  return getLiveCards(state).map((card) => ({
    id: card.id,
    title: card.title,
    columnId: card.columnId,
    position: JSON.stringify(card.position),
    deleted: card.deleted
  }));
}

function shuffle(values, seed = 7) {
  const result = [...values];
  let state = seed;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (state * 9301 + 49297) % 233280;
    const swapIndex = Math.floor((state / 233280) * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

test("HLC uses physical time, logical counter, and site id as total order", () => {
  const clockA = createHLC("a", () => 10);
  const clockB = createHLC("b", () => 10);
  assert.equal(compareHLC(clockA.next(), clockB.next()), -1);

  const clock = createHLC("c", () => 10);
  const first = clock.next();
  const second = clock.next();
  assert.equal(compareHLC(first, second), -1);
});

test("fractional positions remain ordered under randomized interleaving", () => {
  const positions = [];
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const index = Math.floor(Math.random() * (positions.length + 1));
    const left = index > 0 ? positions[index - 1] : [];
    const right = index < positions.length ? positions[index] : [];
    const position = positionBetween(left, right, `site-${iteration % 5}`);
    positions.splice(index, 0, position);
  }

  for (let index = 1; index < positions.length; index += 1) {
    assert.equal(comparePositions(positions[index - 1], positions[index]), -1);
  }

  assert.equal(new Set(positions.map((position) => JSON.stringify(position))).size, positions.length);
});

test("20,000 concurrent-style Logoot insertions remain unique and ordered", () => {
  const positions = [];
  for (let iteration = 0; iteration < 20_000; iteration += 1) {
    const index = Math.floor(Math.random() * (positions.length + 1));
    const left = index > 0 ? positions[index - 1] : [];
    const right = index < positions.length ? positions[index] : [];
    const site = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
    positions.splice(index, 0, positionBetween(left, right, site));
  }

  for (let index = 1; index < positions.length; index += 1) {
    assert.equal(comparePositions(positions[index - 1], positions[index]), -1);
  }
  assert.equal(new Set(positions.map((position) => JSON.stringify(position))).size, positions.length);
});

test("CRDT operations commute regardless of delivery order", () => {
  const operations = [
    {
      id: "add-1",
      type: "add",
      cardId: "card-1",
      timestamp: "0000000000000010:00000000:a",
      origin: "a",
      title: "A",
      description: "",
      columnId: "doing",
      position: [["1", "a", "1"]],
      basis: {}
    },
    {
      id: "move-1",
      type: "move",
      cardId: "card-1",
      timestamp: "0000000000000020:00000000:b",
      origin: "b",
      columnId: "done",
      position: [["2", "b", "1"]],
      basis: {}
    },
    {
      id: "update-1",
      type: "update",
      cardId: "card-1",
      timestamp: "0000000000000030:00000000:a",
      origin: "a",
      title: "B",
      description: "done",
      basis: {}
    }
  ];

  const expected = serializeState(mergeOperations(operations));
  for (let seed = 1; seed <= 10; seed += 1) {
    assert.deepEqual(serializeState(mergeOperations(shuffle(operations, seed))), expected);
  }
});

test("mutations arriving before their add operation are retained after late add", () => {
  const add = {
    id: "add",
    type: "add",
    cardId: "card",
    timestamp: "0000000000000010:00000000:a",
    origin: "a",
    title: "old",
    description: "",
    columnId: "backlog",
    position: [["1", "a", "1"]],
    basis: {}
  };
  const update = {
    id: "update",
    type: "update",
    cardId: "card",
    timestamp: "0000000000000020:00000000:b",
    origin: "b",
    title: "new",
    description: "arrived early",
    basis: {}
  };

  const state = createInitialState();
  reduceOperation(state, update);
  reduceOperation(state, add);
  const card = state.cards.get("card");
  assert.equal(card.title, "new");
  assert.equal(card.description, "arrived early");
});

test("concurrent deletion wins over later merged concurrent edits and moves", () => {
  const operations = [
    {
      id: "add",
      type: "add",
      cardId: "card",
      timestamp: "0000000000000010:00000000:a",
      origin: "a",
      title: "old",
      description: "",
      columnId: "backlog",
      position: [["1", "a", "1"]],
      basis: {}
    },
    {
      id: "delete",
      type: "delete",
      cardId: "card",
      timestamp: "0000000000000020:00000000:a",
      origin: "a",
      basis: {}
    },
    {
      id: "concurrent-update",
      type: "update",
      cardId: "card",
      timestamp: "0000000000000020:00000000:b",
      origin: "b",
      title: "should not resurrect",
      description: "",
      basis: {}
    },
    {
      id: "concurrent-move",
      type: "move",
      cardId: "card",
      timestamp: "0000000000000020:00000000:c",
      origin: "c",
      columnId: "done",
      position: [["9", "c", "1"]],
      basis: {}
    }
  ];

  for (let seed = 1; seed <= 10; seed += 1) {
    const state = mergeOperations(shuffle(operations, seed));
    assert.deepEqual(getLiveCards(state), []);
    assert.equal(state.cards.get("card").deleted, true);
  }
});
