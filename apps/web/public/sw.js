// Minimal service worker: makes the app installable (needed for the Android share target).
// It deliberately caches nothing, so forecasts are always fresh.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
