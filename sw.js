// Offline cold start (WP-10, docs/GAP_CLOSURE_PLAN.md). Keeps the app shell on the phone so a
// reload with no signal still opens the PIN gate and the encrypted local data.
//
// Deliberately minimal, ahead of the Phase 4 PWA (docs/PHASE_4_PLAN.md decision 1):
// - the page (index.html): network first, so an online phone always gets the latest release;
//   the cached copy is used when the network fails or is too slow (weak field signal);
// - the pinned supabase-js build: cache first (its URL names an exact version, so it never
//   changes under the same URL);
// - everything else, above all every Supabase API call, is never touched or cached here.
// Sync correctness never depends on this worker: the page itself still pushes and pulls only
// while it is open (docs/PHASE_4_PLAN.md decision 1).
//
// The cache name carries the APP_VERSION the page registered with (sw.js?v=2.99.45), so a new
// release installs a new worker and the old cache is deleted on activate.
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = `c5-shell-${VERSION}`;
const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.112.3/dist/umd/supabase.min.js';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icon.svg', SUPABASE_JS];
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One by one: a single failure (e.g. the CDN unreachable right now) must not leave the page uncached.
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('c5-shell-') && n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

async function pageNetworkFirst(request) {
  const cache = await caches.open(CACHE);
  const network = fetch(request).then((response) => {
    if (response && response.ok) cache.put('index.html', response.clone());
    return response;
  });
  network.catch(() => null); // a late failure after the timeout must not surface as unhandled
  const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS, null));
  try {
    const fast = await Promise.race([network, timeout]);
    if (fast) return fast;
  } catch (e) { /* offline: fall through to the cache */ }
  const cached = await cache.match('index.html') || await cache.match('./');
  if (cached) return cached;
  return network; // nothing cached yet: wait for the network after all
}

async function libraryCacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(SUPABASE_JS);
  if (cached) return cached;
  const response = await fetch(SUPABASE_JS, { mode: 'cors' });
  if (response && response.ok) cache.put(SUPABASE_JS, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (request.mode === 'navigate') {
    event.respondWith(pageNetworkFirst(request));
    return;
  }
  if (request.url === SUPABASE_JS) {
    event.respondWith(libraryCacheFirst(request));
    return;
  }
  const url = new URL(request.url);
  if (url.origin === self.location.origin && /\/(manifest\.webmanifest|icon\.svg)$/.test(url.pathname)) {
    event.respondWith(caches.match(request).then((hit) => hit || fetch(request)));
  }
  // Anything else (Supabase REST/auth/functions, other origins) goes straight to the network.
});
