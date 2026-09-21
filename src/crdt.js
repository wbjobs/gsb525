export const COLUMNS = [
  { id: "backlog", title: "待办" },
  { id: "ready", title: "准备中" },
  { id: "doing", title: "进行中" },
  { id: "done", title: "已完成" }
];

const POSITION_BASE = 16n;
const SITE_HEX_LENGTH = 32;
const NONCE_HEX_LENGTH = 12;
const POSITION_MIN = Object.freeze({ digit: 0n, site: "", nonce: "" });
const POSITION_MAX = Object.freeze({ digit: POSITION_BASE, site: "", nonce: "" });

export function createHLC(siteId, now = Date.now) {
  let latestPhysical = 0n;
  let latestLogical = 0n;

  function stamp(logical) {
    return `${latestPhysical.toString().padStart(16, "0")}:${logical
      .toString()
      .padStart(8, "0")}:${siteId}`;
  }

  return {
    siteId,
    now() {
      return stamp(latestLogical);
    },
    next() {
      const physical = BigInt(now());
      if (physical > latestPhysical) {
        latestPhysical = physical;
        latestLogical = 0n;
      } else {
        latestLogical += 1n;
      }
      return stamp(latestLogical);
    },
    observe(timestamp) {
      const parsed = parseHLC(timestamp);
      if (parsed.physical > latestPhysical) {
        latestPhysical = parsed.physical;
        latestLogical = parsed.logical;
      } else if (parsed.physical === latestPhysical && parsed.logical > latestLogical) {
        latestLogical = parsed.logical;
      }
    }
  };
}

export function parseHLC(timestamp) {
  const [physical, logical, site] = String(timestamp).split(":");
  if (!physical || !logical || !site) {
    throw new Error(`Invalid HLC timestamp: ${timestamp}`);
  }
  return { physical: BigInt(physical), logical: BigInt(logical), site, raw: timestamp };
}

export function compareHLC(left, right) {
  const a = parseHLC(left);
  const b = parseHLC(right);
  if (a.physical !== b.physical) return a.physical < b.physical ? -1 : 1;
  if (a.logical !== b.logical) return a.logical < b.logical ? -1 : 1;
  return a.site < b.site ? -1 : a.site > b.site ? 1 : 0;
}

function normalizeAtom(atom) {
  return { digit: BigInt(`0x${atom[0]}`), site: atom[1], nonce: atom[2] };
}

function comparePositionAtom(left, right) {
  if (left.digit !== right.digit) return left.digit < right.digit ? -1 : 1;
  if (left.site !== right.site) return left.site < right.site ? -1 : 1;
  if (left.nonce !== right.nonce) return left.nonce < right.nonce ? -1 : 1;
  return 0;
}

export function comparePositions(left, right) {
  const maxLength = Math.max(left.length, right.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftAtom = left[index] ? normalizeAtom(left[index]) : POSITION_MIN;
    const rightAtom = right[index] ? normalizeAtom(right[index]) : POSITION_MIN;
    const comparison = comparePositionAtom(leftAtom, rightAtom);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

export function positionBetween(left = [], right = [], siteId, randomValue = Math.random) {
  const prefix = [];

  for (let index = 0; ; index += 1) {
    const leftAtom = left[index] ? normalizeAtom(left[index]) : POSITION_MIN;
    const rightAtom = right[index] ? normalizeAtom(right[index]) : POSITION_MAX;

    if (comparePositionAtom(leftAtom, rightAtom) === 0) {
      if (left[index]) prefix.push(left[index]);
      continue;
    }

    const atom = atomBetween(leftAtom, rightAtom, randomValue);
    if (atom) {
      return [...prefix, atom];
    }

    if (left[index] && index + 1 < left.length) {
      prefix.push(left[index]);
      continue;
    }

    if (right[index] && (!left[index] || index + 1 === left.length)) {
      prefix.push(right[index]);
      continue;
    }

    const parentAtom = left[index] ?? right[index];
    const childDigit = 1n + BigInt(Math.floor(randomValue() * (Number(POSITION_BASE) - 2)));
    return [
      ...prefix,
      [parentAtom.digit.toString(16), parentAtom.site, parentAtom.nonce],
      [childDigit.toString(16), siteId, createNonce(randomValue)]
    ];
  }
}

function atomBetween(leftAtom, rightAtom, randomValue) {
  const digitGap = rightAtom.digit - leftAtom.digit;

  if (digitGap > 1n) {
    const minimum = Number(leftAtom.digit + 1n);
    const maximum = Number(rightAtom.digit - 1n);
    const digit = BigInt(minimum + Math.floor(randomValue() * (maximum - minimum + 1)));
    return [digit.toString(16), createSiteToken(randomValue), createNonce(randomValue)];
  }

  if (digitGap === 0n) {
    const site = hexBetween(leftAtom.site, rightAtom.site, SITE_HEX_LENGTH, randomValue);
    if (site) {
      return [leftAtom.digit.toString(16), site, createNonce(randomValue)];
    }

    if (leftAtom.site === rightAtom.site) {
      const nonce = hexBetween(leftAtom.nonce, rightAtom.nonce, NONCE_HEX_LENGTH, randomValue);
      if (nonce) {
        return [leftAtom.digit.toString(16), leftAtom.site, nonce];
      }
    }
    return null;
  }

  const afterLeft = sameDigitAtomAfter(leftAtom, randomValue);
  if (afterLeft) return afterLeft;
  return sameDigitAtomBefore(rightAtom, randomValue);
}

function sameDigitAtomAfter(atom, randomValue) {
  const site = hexBetween(atom.site, "", SITE_HEX_LENGTH, randomValue);
  if (site) return [atom.digit.toString(16), site, createNonce(randomValue)];
  const nonce = hexBetween(atom.nonce, "", NONCE_HEX_LENGTH, randomValue);
  if (nonce) return [atom.digit.toString(16), atom.site, nonce];
  return null;
}

function sameDigitAtomBefore(atom, randomValue) {
  const site = hexBetween("", atom.site, SITE_HEX_LENGTH, randomValue);
  if (site) return [atom.digit.toString(16), site, createNonce(randomValue)];
  const nonce = hexBetween("", atom.nonce, NONCE_HEX_LENGTH, randomValue);
  if (nonce) return [atom.digit.toString(16), atom.site, nonce];
  return null;
}

function hexBetween(lowerHex, upperHex, length, randomValue) {
  const lower = lowerHex ? BigInt(`0x${lowerHex}`) : 0n;
  const upper = upperHex ? BigInt(`0x${upperHex}`) : 16n ** BigInt(length) - 1n;
  const gap = upper - lower;
  if (gap < 2n) return null;
  const span = gap - 1n;
  let random = 0n;
  do {
    random = randomBigInt(span, randomValue);
  } while (random >= span);
  const value = lower + 1n + random;
  return value.toString(16).padStart(length, "0");
}

function randomBigInt(limit, randomValue) {
  if (limit <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return BigInt(Math.floor(randomValue() * Number(limit)));
  }

  const chunks = 16n;
  const chunkSize = chunks * 8n;
  let result = 0n;
  let multiplier = 1n;
  let remaining = limit;

  while (remaining > 0n) {
    const value = BigInt(Math.floor(randomValue() * 128));
    result += value * multiplier;
    multiplier *= chunkSize;
    remaining /= chunkSize;
  }

  return result % limit;
}

function createSiteToken(randomValue) {
  let token = "";
  for (let index = 0; index < SITE_HEX_LENGTH; index += 1) {
    token += Math.floor(randomValue() * 16).toString(16);
  }
  if (token === "0".repeat(SITE_HEX_LENGTH) || token === "f".repeat(SITE_HEX_LENGTH)) {
    return createSiteToken(randomValue);
  }
  return token;
}

function createNonce(randomValue) {
  let nonce = "";
  for (let index = 0; index < NONCE_HEX_LENGTH; index += 1) {
    nonce += Math.floor(randomValue() * 16).toString(16);
  }
  if (nonce === "0".repeat(NONCE_HEX_LENGTH) || nonce === "f".repeat(NONCE_HEX_LENGTH)) {
    return createNonce(randomValue);
  }
  return nonce;
}

export function createInitialState() {
  return {
    cards: new Map(),
    vector: {},
    pendingMutations: new Map()
  };
}

export function createSeedOperations() {
  const timestamp = "0000000000000000:00000000:seed";
  const positions = [
    [[1n.toString(), "seed", "0000001"]],
    [[2n.toString(), "seed", "0000002"]],
    [[3n.toString(), "seed", "0000003"]],
    [[4n.toString(), "seed", "0000004"]],
    [[5n.toString(), "seed", "0000005"]],
    [[6n.toString(), "seed", "0000006"]]
  ];
  const seeds = [
    ["seed-card-1", "梳理本周目标", "先定义最重要的三个结果。", "backlog", positions[0]],
    ["seed-card-2", "准备发布说明", "汇总已完成功能和已知限制。", "backlog", positions[1]],
    ["seed-card-3", "设计离线队列", "断网时操作继续写入本地日志。", "ready", positions[2]],
    ["seed-card-4", "实现 CRDT 合并", "四标签页验收用例。", "doing", positions[3]],
    ["seed-card-5", "移动、编辑、删除", "所有操作都是可交换的日志。", "doing", positions[4]],
    ["seed-card-6", "初始化看板", "种子数据只用于空数据库。", "done", positions[5]]
  ];

  return seeds.map(([cardId, title, description, columnId, position]) => ({
    id: `seed-op-${cardId}`,
    type: "add",
    cardId,
    timestamp,
    origin: "seed",
    title,
    description,
    columnId,
    position,
    basis: {}
  }));
}

function applyMutation(card, operation) {
  if (operation.type === "delete") {
    if (!card.deleted) {
      card.deleted = true;
      card.movedAt = operation.timestamp;
    }
    return;
  }

  if (operation.type === "update") {
    if (compareHLC(operation.timestamp, card.contentAt) > 0) {
      card.title = operation.title;
      card.description = operation.description ?? "";
      card.contentAt = operation.timestamp;
    }
  } else if (operation.type === "move") {
    if (compareHLC(operation.timestamp, card.movedAt) >= 0) {
      card.columnId = operation.columnId;
      card.position = operation.position;
      card.movedAt = operation.timestamp;
    }
  }
}

export function reduceOperation(state, operation) {
  mergeVector(state.vector, operation.origin, operation.timestamp);

  if (operation.type === "add") {
    if (!state.cards.has(operation.cardId)) {
      state.cards.set(operation.cardId, {
        id: operation.cardId,
        title: operation.title,
        description: operation.description ?? "",
        columnId: operation.columnId,
        position: operation.position,
        createdAt: operation.timestamp,
        contentAt: operation.timestamp,
        movedAt: operation.timestamp,
        deleted: false
      });

      const pending = (state.pendingMutations.get(operation.cardId) ?? [])
        .slice()
        .sort((left, right) => compareHLC(left.timestamp, right.timestamp));
      for (const mutation of pending) applyMutation(state.cards.get(operation.cardId), mutation);
      state.pendingMutations.delete(operation.cardId);
    }
    return state;
  }

  const card = state.cards.get(operation.cardId);
  if (!card) {
    if (operation.type === "delete") {
      state.cards.set(operation.cardId, {
        id: operation.cardId,
        title: "",
        description: "",
        columnId: COLUMNS[0].id,
        position: [],
        createdAt: operation.timestamp,
        contentAt: operation.timestamp,
        movedAt: operation.timestamp,
        deleted: true
      });
      state.pendingMutations.delete(operation.cardId);
    } else {
      const pending = state.pendingMutations.get(operation.cardId) ?? [];
      pending.push(operation);
      state.pendingMutations.set(operation.cardId, pending);
    }
    return state;
  }

  applyMutation(card, operation);
  return state;
}

export function mergeOperations(operations) {
  return operations.reduce(reduceOperation, createInitialState());
}

export function getLiveCards(state) {
  return [...state.cards.values()].filter((card) => !card.deleted);
}

export function getCardsByColumn(state) {
  const grouped = new Map(COLUMNS.map((column) => [column.id, []]));
  for (const card of getLiveCards(state)) {
    grouped.get(card.columnId)?.push(card);
  }
  for (const cards of grouped.values()) {
    cards.sort((left, right) => comparePositions(left.position, right.position));
  }
  return grouped;
}

export function nextPosition(state, columnId, targetIndex, siteId, movingCardId = null, randomValue = Math.random) {
  const cards = getLiveCards(state)
    .filter((card) => card.columnId === columnId && card.id !== movingCardId)
    .sort((left, right) => comparePositions(left.position, right.position));
  const boundedIndex = Math.max(0, Math.min(targetIndex, cards.length));
  const left = boundedIndex > 0 ? cards[boundedIndex - 1].position : [];
  const right = boundedIndex < cards.length ? cards[boundedIndex].position : [];
  return positionBetween(left, right, siteId, randomValue);
}

export function mergeVector(vector, siteId, timestamp) {
  if (
    !Object.prototype.hasOwnProperty.call(vector, siteId) ||
    compareHLC(timestamp, vector[siteId]) > 0
  ) {
    vector[siteId] = timestamp;
  }
}

export function hasOperation(vector, operation) {
  const known = vector[operation.origin];
  return Boolean(known) && compareHLC(known, operation.timestamp) >= 0;
}

export function missingOperations(operations, vector) {
  return operations.filter((operation) => !hasOperation(vector, operation));
}
