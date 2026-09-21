export function createBroadcastBus(channelName = "crdt-kanban-v1") {
  const channel = new BroadcastChannel(channelName);
  const listeners = new Set();

  channel.onmessage = (event) => {
    for (const listener of listeners) listener(event.data);
  };

  return {
    post(message) {
      channel.postMessage(message);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      listeners.clear();
      channel.close();
    }
  };
}

export function createMemoryBus() {
  const buses = new Set();

  function makeBus() {
    const listeners = new Set();
    const bus = {
      post(message) {
        for (const peerListeners of buses) {
          if (peerListeners !== listeners) {
            queueMicrotask(() => {
              for (const listener of peerListeners) listener(structuredClone(message));
            });
          }
        }
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close() {
        buses.delete(listeners);
      }
    };
    buses.add(listeners);
    return bus;
  }

  return { makeBus };
}
