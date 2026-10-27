// The background image file picked in the settings. Kept as a Blob in IndexedDB rather
// than a data URL in storage.local: no base64 inflation, no storage.local quota, and a
// new tab doesn't parse megabytes of JSON before showing it.
const DB_NAME = "kMarkTab";
const STORE = "files";
const KEY = "background";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Resolves once the transaction commits, not when the request succeeds: a write isn't
// durable before that
async function inStore<T>(
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = op(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function loadImageFile(): Promise<Blob | undefined> {
  return inStore<Blob | undefined>("readonly", (store) => store.get(KEY));
}

export async function saveImageFile(file: Blob): Promise<void> {
  await inStore("readwrite", (store) => store.put(file, KEY));
}

export async function deleteImageFile(): Promise<void> {
  await inStore("readwrite", (store) => store.delete(KEY));
}
