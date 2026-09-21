const DATABASE_NAME = "crdt-kanban-v1";
const DATABASE_VERSION = 1;

export function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("operations")) {
        database.createObjectStore("operations", { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function createIdbStorage(database) {
  function transaction(mode) {
    return database.transaction("operations", mode).objectStore("operations");
  }

  return {
    getAll() {
      return new Promise((resolve, reject) => {
        const request = transaction("readonly").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    },

    put(operation) {
      return new Promise((resolve, reject) => {
        const request = transaction("readwrite").put(operation);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    },

    putMany(operations) {
      return new Promise((resolve, reject) => {
        const tx = database.transaction("operations", "readwrite");
        const store = tx.objectStore("operations");
        for (const operation of operations) {
          store.put(operation);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
  };
}

export function createMemoryStorage(initial = []) {
  const operations = new Map(initial.map((operation) => [operation.id, operation]));

  return {
    getAll: async () => [...operations.values()],
    put: async (operation) => {
      operations.set(operation.id, operation);
    },
    putMany: async (incoming) => {
      for (const operation of incoming) operations.set(operation.id, operation);
    }
  };
}
