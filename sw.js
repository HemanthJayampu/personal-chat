// Personal Chat service worker: installable PWA, offline app shell,
// notification clicks. Never caches Supabase API, auth or file traffic.
// Bump VERSION whenever you deploy so phones pick up the new files.
const VERSION = "v1.0.1";
const CACHE = `pchat-${VERSION}`;

const SHELL = [
  "./", "index.html", "style.css", "config.js", "manifest.json",
  "js/app.js", "js/auth.js", "js/session.js", "js/chat.js", "js/files.js",
  "js/admin.js", "js/settings.js", "js/notify.js", "js/ui.js", "js/supabase.js",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // App files: network first so a deploy shows up at once, cache when offline.
  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
        return res;
      } catch {
        return (await caches.match(req, { ignoreSearch: true })) || caches.match("index.html");
      }
    })());
    return;
  }

  // The pinned supabase-js build from esm.sh never changes: cache first.
  if (url.hostname === "esm.sh") {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
      return res;
    })());
  }
  // Everything else (Supabase) goes straight to the network.
});

// Open (or focus) the app when a message notification is tapped.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) if ("focus" in w) return w.focus();
    return self.clients.openWindow("./");
  })());
});
