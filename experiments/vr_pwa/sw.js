// Butterchurn VR Dome — service worker
//
// Caches the app shell (this HTML file, the manifest, icons, and all
// vendored libraries under ./libs/) so the page itself opens offline /
// installs as a standalone app. Everything the app needs — Butterchurn,
// preset packs, fonts — is vendored locally rather than loaded from a
// third-party CDN, so all caching here is same-origin; there's no
// cross-origin fetch handling to speak of.

// PRESET_BUNDLE_VERSION in index.html
const CACHE_VERSION = 'v1';
const CACHE_NAME = `butterchurn-vr-shell-${CACHE_VERSION}`;

const APP_SHELL = [
  './index.html',
'./manifest.webmanifest',
'./favicon.ico',
'./logo192.png',
'./logo512.png',
'./preset-playlists.json',
'./libs/butterchurn@3.0.0-beta.5.js'
];
// Deliberately NOT precached here: /presets-bundle.json gets cached
// opportunistically the first time index.html fetches it (same cache-first
// path as any other same-origin request, below) — but its real destination
// is being unpacked into individual ./presets/<key>.json entries (see the
// UNPACK_PRESET_BUNDLE message handler), so we don't want it permanently
// occupying cache storage twice over on top of those.

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch((err) => console.warn('[sw] shell precache failed:', err))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Runs `fn` over `items`, at most `limit` concurrently, instead of firing
// them all at once. With potentially hundreds of presets, a plain
// `Promise.allSettled(items.map(fn))` launches that many fetch() calls in
// the same tick — well past the browser's per-origin connection ceiling,
// which can stall/queue unrelated requests (preset loads during actual
// playback, menu clicks) or hit the pending-request ceiling outright.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i], i) };
      } catch (err) {
        results[i] = { status: 'rejected', reason: err };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // nothing is cross-origin anymore; let it go through untouched

  // App shell: cache-first, refresh in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      }).catch(() => cached);
      return cached || network;
    })
  );
});

// Messages from the page (see index.html's refreshPwaCache()/
// loadAndUnpackPresetBundle()):
//   { type: 'UNPACK_PRESET_BUNDLE', presets: { key: presetData, ... } }
//     The page downloads /presets-bundle.json itself (so it can track byte
//     progress for the loading bar), then hands us the parsed object. We
//     split it back into individual ./presets/<key>.json cache entries —
//     matching exactly what per-preset fetches would have produced — so
//     getPresetData() in index.html keeps working unchanged, just served
//     from cache instead of network. No fetch() happens on this side at
//     all (it's local cache writes only), so concurrency can be much
//     higher than a network-bound operation would allow. Progress is
//     reported back via UNPACK_PROGRESS messages, throttled to ~12/sec.
//   { type: 'REFRESH_SHELL' }
//     Force re-fetches every APP_SHELL file, bypassing the HTTP cache.
// Both reply with a *_DONE message back to whichever client sent the request.
self.addEventListener('message', (event) => {
  const data = event.data || {};

  if (data.type === 'UNPACK_PRESET_BUNDLE' && data.presets && typeof data.presets === 'object') {
    const entries = Object.entries(data.presets);
    const total = entries.length;
    const source = event.source;

    event.waitUntil(
      caches.open(CACHE_NAME).then((cache) => {
        let done = 0;
        let lastReport = 0;
        return mapWithConcurrency(entries, 16, async ([key, presetData]) => {
          const url = `/presets/${encodeURIComponent(key)}.json`;
          await cache.put(url, new Response(JSON.stringify(presetData), {
            headers: { 'Content-Type': 'application/json' },
          }));
          done++;
          const now = Date.now();
          if (source && (now - lastReport > 80 || done === total)) {
            lastReport = now;
            source.postMessage({ type: 'UNPACK_PROGRESS', done, total });
          }
        });
      }).then(() => {
        if (source) source.postMessage({ type: 'UNPACK_DONE', total });
      }).catch((err) => {
        if (source) source.postMessage({ type: 'UNPACK_ERROR', message: err.message });
      })
    );
  }

  if (data.type === 'REFRESH_SHELL') {
    event.waitUntil(
      caches.open(CACHE_NAME).then((cache) =>
        Promise.allSettled(APP_SHELL.map((url) =>
          fetch(url, { cache: 'reload' }).then((res) => {
            if (!res || !res.ok) throw new Error(`HTTP ${res && res.status}`);
            return cache.put(url, res.clone());
          })
        ))
      ).then(() => {
        if (event.source) event.source.postMessage({ type: 'REFRESH_SHELL_DONE' });
      })
    );
  }
});
