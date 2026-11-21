const prefix = 'atlas-trip:' + self.registration.scope + ':';
const cacheName = prefix + '13b76041310140b1';
const assets = ['./index.html', './manifest.webmanifest', './icons/atlas-180.png', './icons/atlas-192.png', './icons/atlas-512.png'];
const urls = new Set(assets.map(path => new URL(path, self.registration.scope).href));

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    await cache.addAll(assets.map(path => new Request(path, {cache: 'reload'})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(prefix) && key !== cacheName) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

async function openApp(request) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(request, {cache: 'no-store', signal: controller.signal});
    if (response.ok) return response;
    return (await caches.match('./index.html', {cacheName})) || response;
  } catch (error) {
    const cached = await caches.match('./index.html', {cacheName});
    if (cached) return cached;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  url.search = '';
  const home = url.href === self.registration.scope && event.request.mode === 'navigate';
  if (!home && !urls.has(url.href)) return;
  if (home || (event.request.mode === 'navigate' && url.href === new URL('./index.html', self.registration.scope).href)) {
    event.respondWith(openApp(event.request));
    return;
  }
  const key = url.href;
  event.respondWith(caches.open(cacheName).then(async cache =>
    (await cache.match(key)) || fetch(event.request)
  ));
});
