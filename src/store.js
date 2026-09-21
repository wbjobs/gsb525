import {
  createHLC,
  createInitialState,
  createSeedOperations,
  mergeOperations,
  missingOperations,
  nextPosition,
  reduceOperation,
  hasOperation
} from "./crdt.js";

export function createSiteId() {
  if (globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

export function createOperationId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `op-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export function createBoardStore({
  storage,
  bus,
  siteId = createSiteId(),
  now = () => Date.now(),
  randomValue = Math.random
}) {
  const clock = createHLC(siteId, now);
  const listeners = new Set();
  const peers = new Map();
  const pendingHellos = new Map();
  const unconfirmedLocal = new Set();
  const seedOperations = createSeedOperations();

  let operations = [];
  let state = createInitialState();
  let connected = true;
  let lastLatency = null;

  function emit(type, detail = {}) {
    for (const listener of listeners) listener({ type, ...detail });
  }

  function snapshot() {
    return {
      operations,
      state,
      siteId,
      connected,
      peers: peers.size,
      pending: unconfirmedLocal.size,
      latency: lastLatency
    };
  }

  function applyOperation(operation) {
    clock.observe(operation.timestamp);
    if (operations.some((existing) => existing.id === operation.id)) return false;
    reduceOperation(state, operation);
    operations.push(operation);
    return true;
  }

  async function handleIncomingOperations(incoming) {
    const fresh = [];
    for (const operation of incoming) {
      if (applyOperation(operation)) fresh.push(operation);
    }
    if (fresh.length > 0) await storage.putMany(fresh);
    return fresh;
  }

  function postOperations(targetOperations) {
    if (connected && targetOperations.length > 0) {
      bus.post({
        type: "ops",
        from: siteId,
        vector: state.vector,
        operations: targetOperations,
        sentAt: now()
      });
    }
  }

  async function commitLocal(operation) {
    applyOperation(operation);
    await storage.put(operation);

    if (connected) {
      postOperations([operation]);
    }
    unconfirmedLocal.add(operation.id);
    emit("state", { local: true, operations: [operation] });
  }

  function confirmVector(vector) {
    for (const operation of operations) {
      if (operation.origin === siteId && hasOperation(vector, operation)) {
        unconfirmedLocal.delete(operation.id);
      }
    }
  }

  function sendHello() {
    const nonce = createOperationId();
    pendingHellos.set(nonce, now());
    bus.post({ type: "hello", from: siteId, nonce, vector: state.vector, at: now() });
  }

  function handleHello(message) {
    if (message.from === siteId) return;
    peers.set(message.from, now());
    confirmVector(message.vector);
    bus.post({
      type: "welcome",
      from: siteId,
      to: message.from,
      nonce: message.nonce,
      vector: state.vector,
      operations: missingOperations(operations, message.vector),
      at: now()
    });
  }

  async function handleWelcome(message) {
    if (message.to !== siteId) return;
    peers.set(message.from, now());

    const startedAt = pendingHellos.get(message.nonce);
    if (startedAt !== undefined) {
      lastLatency = Math.max(0, now() - startedAt);
      pendingHellos.delete(message.nonce);
    }

    const fresh = await handleIncomingOperations(message.operations);
    confirmVector(message.vector);
    postOperations(missingOperations(operations, message.vector));
    if (fresh.length > 0) emit("state", { remote: true, operations: fresh });
    emit("status");
  }

  async function handleOps(message) {
    if (message.from === siteId) return;
    peers.set(message.from, now());
    const receivedAt = now();
    const fresh = await handleIncomingOperations(message.operations);
    if (message.vector) confirmVector(message.vector);
    postOperations(missingOperations(operations, message.vector ?? {}));
    if (message.sentAt !== undefined) {
      lastLatency = receivedAt - message.sentAt;
    }
    if (fresh.length > 0) emit("state", { remote: true, operations: fresh, receivedAt });
    emit("status");
  }

  bus.subscribe((message) => {
    if (!connected) return;
    if (message.type === "hello") handleHello(message);
    else if (message.type === "welcome") void handleWelcome(message);
    else if (message.type === "ops") void handleOps(message);
    else if (message.type === "ping" && message.from !== siteId) {
      peers.set(message.from, now());
      bus.post({ type: "pong", from: siteId, to: message.from });
    } else if (message.type === "pong" && message.to === siteId) {
      peers.set(message.from, now());
    }
  });

  async function start() {
    const stored = await storage.getAll();
    if (stored.length === 0) {
      for (const operation of seedOperations) applyOperation(operation);
      await storage.putMany(seedOperations);
    } else {
      state = mergeOperations(stored);
      operations = stored;
      let changed = false;
      for (const operation of seedOperations) {
        if (
          !hasOperation(state.vector, operation) &&
          !operations.some((item) => item.id === operation.id)
        ) {
          applyOperation(operation);
          changed = true;
        }
      }
      if (changed) await storage.putMany(operations.slice(stored.length));
    }

    emit("state", { bootstrap: true });
    if (connected) sendHello();
    emit("status");
    return snapshot();
  }

  function setConnected(value) {
    if (connected === value) return;
    connected = value;
    if (connected) {
      sendHello();
    }
    emit("status");
    emit("state");
  }

  function prunePeers() {
    const cutoff = now() - 6000;
    for (const [peerId, lastSeen] of peers) {
      if (lastSeen < cutoff) peers.delete(peerId);
    }
    emit("status");
  }

  function heartbeat() {
    prunePeers();
    if (connected) {
      bus.post({ type: "ping", from: siteId, at: now() });
    }
  }

  function basis() {
    return { ...state.vector };
  }

  function addCard(columnId, title) {
    const timestamp = clock.next();
    const operation = {
      id: createOperationId(),
      type: "add",
      cardId: createOperationId(),
      timestamp,
      origin: siteId,
      title,
      description: "",
      columnId,
      position: nextPosition(state, columnId, Number.POSITIVE_INFINITY, siteId, null, randomValue),
      basis: basis()
    };
    return commitLocal(operation);
  }

  function updateCard(cardId, title, description) {
    const operation = {
      id: createOperationId(),
      type: "update",
      cardId,
      timestamp: clock.next(),
      origin: siteId,
      title,
      description,
      basis: basis()
    };
    return commitLocal(operation);
  }

  function moveCard(cardId, columnId, targetIndex) {
    const operation = {
      id: createOperationId(),
      type: "move",
      cardId,
      timestamp: clock.next(),
      origin: siteId,
      columnId,
      position: nextPosition(state, columnId, targetIndex, siteId, cardId, randomValue),
      basis: basis()
    };
    return commitLocal(operation);
  }

  function deleteCard(cardId) {
    const operation = {
      id: createOperationId(),
      type: "delete",
      cardId,
      timestamp: clock.next(),
      origin: siteId,
      basis: basis()
    };
    return commitLocal(operation);
  }

  return {
    start,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    getOperations: () => operations,
    getSnapshot: snapshot,
    setConnected,
    heartbeat,
    addCard,
    updateCard,
    moveCard,
    deleteCard
  };
}
