/* eslint-disable no-restricted-globals */
/**
 * CamScan — service worker (offline shell + OCR/font caching).
 *
 * Strategy
 *  - App shell (HTML/JS/CSS from Next) : network-first, fall back to cache.
 *    This keeps the app updated while still working offline.
 *  - Immutable assets (fonts, tessdata, wasm, icons) : cache-first.
 *  - Page navigations : network-first with a cached shell fallback.
 *  - Never caches IndexedDB data (that lives in the page's own storage).
 *
 * What works offline after one online visit
 *  ✔ the whole UI, scanning, OCR with already-downloaded language packs
 *  ✔ reading, editing, search, PDF export (all local)
 *  ✘ a language pack never downloaded before (needs one online fetch)
 */
const VERSION = 'camscan-v1';
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;

const PRECACHE = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/fonts/fonts.css',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE).catch(() => undefined)),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

const isImmutableAsset = (url) =>
  /\/(fonts|tessdata|vendor|icons|workers)\//.test(url.pathname) ||
  /\.(woff2?|ttf|wasm|traineddata|png|jpg|jpeg|svg)$/.test(url.pathname);

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // never proxy third parties

  // Immutable assets → cache-first (they are content-addressed by name).
  if (isImmutableAsset(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSET_CACHE);
        const hit = await cache.match(request);
        if (hit) return hit;
        try {
          const res = await fetch(request);
          if (res.ok) cache.put(request, res.clone());
          return res;
        } catch (err) {
          return new Response('', { status: 504, statusText: 'offline and not cached' });
        }
      })(),
    );
    return;
  }

  // Navigations & app code → network-first with cache fallback.
  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      try {
        const res = await fetch(request);
        if (res.ok && (request.mode === 'navigate' || url.pathname.startsWith('/_next/'))) {
          cache.put(request, res.clone());
        }
        return res;
      } catch (err) {
        const hit = await cache.match(request);
        if (hit) return hit;
        if (request.mode === 'navigate') {
          const shell = await cache.match('/');
          if (shell) return shell;
        }
        return new Response('Offline', { status: 503 });
      }
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
