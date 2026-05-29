/* ══ BlockBoard Service Worker — v15 ══════════════════════════
   Strategy:
   - index.html: network-first, 5s timeout, cache fallback
     → always fresh UI when online, fixes S21 no-update bug
   - sw.js, manifest.json: network-first, cache fallback
   - api.php: network only, never cache
   - External APIs: network only
   - Icons: cache-first (never change between versions)
   ══════════════════════════════════════════════════════════ */

const CACHE = 'blockboard-v15';
const SHELL = ['./index.html', './manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

function networkFirst(request, timeoutMs) {
  return new Promise(resolve => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        caches.match(request).then(cached => resolve(cached || fetch(request)));
      }
    }, timeoutMs);

    fetch(request.clone())
      .then(resp => {
        clearTimeout(timer);
        if (!done) {
          done = true;
          if (resp && resp.status === 200 && resp.type !== 'opaque') {
            caches.open(CACHE).then(c => c.put(request, resp.clone()));
          }
          resolve(resp);
        }
      })
      .catch(() => {
        clearTimeout(timer);
        if (!done) {
          done = true;
          caches.match(request).then(cached => resolve(cached));
        }
      });
  });
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  if (url.pathname.includes('api.php')) {
    e.respondWith(fetch(e.request));
    return;
  }

  const ext = [
    'mempool.space', 'api.kraken.com', 'www.bitstamp.net',
    'api.coingecko.com', 'wttr.in', 'bitbo.io', 'farside.co.uk',
    'blockstream.info', 'alternative.me', '1ml.com'
  ];
  if (ext.some(h => url.hostname.includes(h))) {
    e.respondWith(fetch(e.request));
    return;
  }

  if (url.pathname.includes('/icons/')) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    );
    return;
  }

  e.respondWith(networkFirst(e.request, 5000));
});
