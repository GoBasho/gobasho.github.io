/* Meridian service worker: cache the app shell so the planner opens
   offline (data comes from the last-synced snapshot in localStorage). */
const CACHE = "meridian-v1";
const SHELL = [
  "./", "index.html", "config.js", "storage.js", "manifest.json", "icon.svg",
  "vendor/leaflet/leaflet.css", "vendor/leaflet/leaflet.js"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== "GET") return;
  // network first so deploys land quickly, cache as the offline fallback
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: url.pathname.endsWith("/") }))
  );
});
