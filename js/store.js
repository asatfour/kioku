/**
 * IndexedDB による永続化。
 * .apkg は「入出力の形式」であって、動作中の正本はこちら。
 */

const DB_NAME = "kioku";
const DB_VERSION = 1;

/** @type {IDBDatabase|null} */
let db = null;

export async function open() {
  if (db) return db;
  db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = req.result;
      if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta");
      if (!d.objectStoreNames.contains("notetypes")) d.createObjectStore("notetypes", { keyPath: "id" });
      if (!d.objectStoreNames.contains("decks")) d.createObjectStore("decks", { keyPath: "id" });
      if (!d.objectStoreNames.contains("notes")) {
        const s = d.createObjectStore("notes", { keyPath: "id" });
        s.createIndex("mid", "mid");
      }
      if (!d.objectStoreNames.contains("cards")) {
        const s = d.createObjectStore("cards", { keyPath: "id" });
        s.createIndex("did", "did");
        s.createIndex("due", "due");
        s.createIndex("nid", "nid");
      }
      if (!d.objectStoreNames.contains("revlog")) {
        const s = d.createObjectStore("revlog", { keyPath: "id", autoIncrement: true });
        s.createIndex("cardId", "cardId");
        s.createIndex("reviewedAt", "reviewedAt");
      }
      if (!d.objectStoreNames.contains("media")) d.createObjectStore("media");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return db;
}

function tx(stores, mode = "readonly") {
  return db.transaction(stores, mode);
}

const done = (t) =>
  new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });

const reqp = (r) =>
  new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });

export async function getMeta(key, dflt = null) {
  await open();
  const v = await reqp(tx(["meta"]).objectStore("meta").get(key));
  return v === undefined ? dflt : v;
}

export async function setMeta(key, value) {
  await open();
  const t = tx(["meta"], "readwrite");
  t.objectStore("meta").put(value, key);
  return done(t);
}

export async function getAll(store) {
  await open();
  return reqp(tx([store]).objectStore(store).getAll());
}

export async function get(store, key) {
  await open();
  return reqp(tx([store]).objectStore(store).get(key));
}

export async function putAll(store, items) {
  await open();
  const CHUNK = 500;
  for (let i = 0; i < items.length; i += CHUNK) {
    const t = tx([store], "readwrite");
    const os = t.objectStore(store);
    for (const it of items.slice(i, i + CHUNK)) os.put(it);
    await done(t);
  }
}

export async function put(store, item) {
  await open();
  const t = tx([store], "readwrite");
  t.objectStore(store).put(item);
  return done(t);
}

export async function count(store) {
  await open();
  return reqp(tx([store]).objectStore(store).count());
}

export async function clearAll() {
  await open();
  const names = ["meta", "notetypes", "decks", "notes", "cards", "revlog", "media"];
  const t = tx(names, "readwrite");
  for (const n of names) t.objectStore(n).clear();
  return done(t);
}

// ---- メディア ----

export async function putMedia(map) {
  await open();
  const entries = [...map.entries()];
  const CHUNK = 40;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const t = tx(["media"], "readwrite");
    const os = t.objectStore("media");
    for (const [name, bytes] of entries.slice(i, i + CHUNK)) {
      os.put(bytes instanceof Blob ? bytes : new Blob([bytes]), name);
    }
    await done(t);
  }
}

export async function getMediaBlob(name) {
  await open();
  return reqp(tx(["media"]).objectStore("media").get(name));
}

export async function mediaNames() {
  await open();
  return reqp(tx(["media"]).objectStore("media").getAllKeys());
}

/** メディアを Blob URL にして貼れる形にする（使い終わったら revoke する） */
export async function buildMediaUrls(names) {
  const urls = new Map();
  for (const n of names) {
    const blob = await getMediaBlob(n);
    if (blob) urls.set(n, URL.createObjectURL(blob));
  }
  return urls;
}

// ---- 復習ログ ----

export async function addRevlog(entry) {
  await open();
  const t = tx(["revlog"], "readwrite");
  t.objectStore("revlog").add(entry);
  return done(t);
}

export async function revlogSince(sinceMs) {
  await open();
  const range = IDBKeyRange.lowerBound(sinceMs);
  return reqp(tx(["revlog"]).objectStore("revlog").index("reviewedAt").getAll(range));
}

export async function revlogForCard(cardId) {
  await open();
  return reqp(tx(["revlog"]).objectStore("revlog").index("cardId").getAll(cardId));
}
