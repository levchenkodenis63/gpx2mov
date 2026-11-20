const prefix = 'atlas-trip:' + self.registration.scope + ':';
const cacheName = prefix + '2d4c7d0e838d5dfd';
const assets = ['./index.html', './manifest.webmanifest', './icons/atlas-180.png', './icons/atlas-192.png', './icons/atlas-512.png'];
const urls = new Set(assets.map(path => new URL(path, self.registration.scope).href));

self.addEventListener('install', event => {
  event.waitUntil(caches.open(cacheName).then(cache =>
    cache.addAll(assets.map(path => new Request(path, {cache: 'reload'})))
  ));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(prefix) && key !== cacheName) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  url.search = '';
  const home = url.href === self.registration.scope && event.request.mode === 'navigate';
  if (!home && !urls.has(url.href)) return;
  const key = home ? './index.html' : url.href;
  event.respondWith(caches.open(cacheName).then(async cache =>
    (await cache.match(key)) || fetch(event.request)
  ));
});
