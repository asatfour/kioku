/**
 * オフラインでも起動できるようにするための Service Worker。
 *
 * 方針: アプリ本体（html/css/js）は「まず通信・駄目ならキャッシュ」、
 *       vendor の巨大な固定物（wasm/MathJax）は「まずキャッシュ」。
 * 理由: 全部 cache-first にすると、PC 側で直してもスマホに更新が永久に届かない。
 *       逆に全部 network-first にすると、起動のたびに 1MB 超を取りに行って遅い。
 */
const CACHE = "kioku-v11";
const ASSETS = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "LICENSES.txt",
  "css/style.css",
  "js/main.js",
  "js/store.js",
  "js/apkg.js",
  "js/fsrs.js",
  "js/render.js",
  "js/queue.js",
  "js/pb.js",
  "js/ai.js",
  "vendor/sql-wasm.js",
  "vendor/sql-wasm.wasm",
  "vendor/jszip.min.js",
  "vendor/fzstd.js",
  "vendor/tex-mml-chtml.js",
];

/** 中身が変わらない前提の重い資産。ここだけキャッシュ優先。 */
function isImmutable(pathname) {
  return /\/vendor\/|\.(?:wasm|png|woff2?)$/.test(pathname);
}

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) (await caches.open(CACHE)).put(req, res.clone()).catch(() => {});
  return res;
}

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(CACHE)).put(req, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    const hit = await caches.match(req);
    if (hit) return hit; // 圏外・機内モードでもここで起動できる
    throw e;
  }
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // AI通信は素通し
  e.respondWith(isImmutable(url.pathname) ? cacheFirst(e.request) : networkFirst(e.request));
});
