const dbName = "biubiu-desktop-playlists";
const storeName = "playlists";
const changeEvent = "desktop-playlists:changed";

export interface Entries {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): void;
  delete(key: string): void;
  clear(): void;
}

function result<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Nothing is opened at import time; all reads/writes in a callback share one transaction. */
export async function transaction<T>(mode: IDBTransactionMode, run: (entries: Entries) => Promise<T>): Promise<T> {
  const request = indexedDB.open(dbName, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(storeName);
  const db = await result(request);
  try {
    const tx = db.transaction(storeName, mode);
    const finished = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("歌单数据库操作已取消"));
    });
    const store = tx.objectStore(storeName);
    const work = async () => {
      try {
        return await run({
          get: key => result(store.get(key)),
          put: (key, value) => store.put(value, key),
          delete: key => store.delete(key),
          clear: () => store.clear(),
        });
      } catch (error) {
        // A failed invariant/serialization must roll back even the preceding writes.
        try {
          tx.abort();
        } catch {
          /* Request may already have aborted. */
        }
        throw error;
      }
    };
    const [value] = await Promise.all([work(), finished]);
    if (mode === "readwrite") window.dispatchEvent(new Event(changeEvent));
    return value;
  } finally {
    db.close();
  }
}

export function onDesktopPlaylistsChange(refresh: () => void) {
  window.addEventListener(changeEvent, refresh);
  return () => window.removeEventListener(changeEvent, refresh);
}
