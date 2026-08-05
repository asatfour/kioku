// 比較用の最小 Service Worker。fetch ハンドラがあることだけが要件。
self.addEventListener("install", (e) => e.waitUntil(
  caches.open("mini-v1").then((c) => c.addAll(["./", "./index.html", "./manifest.webmanifest"]))
    .then(() => self.skipWaiting())
));
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
