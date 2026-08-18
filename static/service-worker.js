const CACHE_NAME = "playlist-studio-player-v9";
const APP_SHELL = [
  "./player.html",
  "./player.css",
  "./player.js",
  "./manifest.webmanifest",
  "./icon.svg",
];
const CACHEABLE_EXTERNAL_HOSTS = new Set([
  "cdn.jsdelivr.net",
  "cdnjs.cloudflare.com",
  "accounts.google.com",
]);
const APP_SHELL_URLS = new Set(APP_SHELL.map((path) => new URL(path, self.location).href));

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;
  const externalScript = CACHEABLE_EXTERNAL_HOSTS.has(url.hostname);
  const appShellRequest = sameOrigin && APP_SHELL_URLS.has(url.href);
  if (!appShellRequest && !externalScript) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((response) => {
        if (response.ok || response.type === "opaque") {
          caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
        }
        return response;
      }).catch(() => cached);

      if (cached) {
        network.catch(() => {});
        return cached;
      }
      return network;
    })
  );
});
