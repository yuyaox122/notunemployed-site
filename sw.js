// Service worker. Two rules:
//   1. ALWAYS show a notification — Safari revokes permission for a silent push.
//   2. Log arrivals to Cache Storage, so a push that lands while the app is closed
//      is still counted when you next open it.
const LOG = "bell-arrivals";

self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_) { d = {}; }
  const title = d.title || "New opening";
  const body = d.body || "";
  event.waitUntil((async () => {
    try {
      const c = await caches.open(LOG);
      const prev = await c.match("log");
      const arr = prev ? await prev.json() : [];
      // `key` is the push's tag (a posting, `bell-digest`, `bell-rollup`), so a week of
      // this log can be read against `delivery` push by push (plan item 29).
      arr.push({ title, key: d.key || d.tag || "", sent_at: d.sent_at,
                 received_at: Date.now() / 1000 });
      await c.put("log", new Response(JSON.stringify(arr.slice(-200))));
    } catch (_) {}
    // Rule 1 — unconditional.
    //
    // `timestamp` is the moment bell SENT the push (`sent_at`), not the moment the OS
    // drew the notification. Without it a push delayed in Apple's queue is stamped
    // with its delivery time, which is exactly the number this project claims to
    // minimise.
    //
    // `requireInteraction` only for a real deadline inside 48h: a notification that
    // refuses to go away is a good way to be turned off, so it is spent on the one
    // case where missing it costs the whole opportunity.
    const actions = d.count > 1
      ? [{ action: "open", title: "See all" }]
      : [{ action: "open", title: "Open posting" },
         { action: "later", title: "Not for me" }];
    await self.registration.showNotification(title, {
      body,
      tag: d.tag || title,
      data: { url: d.url, key: d.key || "" },
      badge: "icon-192.png",
      icon: "icon-192.png",
      timestamp: d.sent_at ? d.sent_at * 1000 : Date.now(),
      requireInteraction: !!d.urgent,
      renotify: !!d.count,
      actions,
    });
  })());
});

// Same rule as app.js safeUrl(): the payload is ours, but its `url` comes from a
// third-party job board, and a service worker opening an arbitrary scheme is a worse
// place to be careless than a link in a page.
function safeUrl(u) {
  if (!u) return "";
  var t = String(u).replace(/^[\u0000-\u0020]+/, "");
  return /^https?:\/\//i.test(t) ? t : "";
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};

  // "Not for me" must not open a tab. It records the posting's key in Cache Storage,
  // and app.js marks that row "not for me" the next time it opens on this origin.
  if (event.action === "later") {
    event.waitUntil((async () => {
      try {
        const c = await caches.open(LOG);
        const prev = await c.match("dismissed");
        const arr = prev ? await prev.json() : [];
        if (data.key) arr.push(data.key);
        await c.put("dismissed", new Response(JSON.stringify(arr.slice(-500))));
      } catch (_) {}
    })());
    return;
  }

  // A rollup notification has no single url; fall back to the app rather than
  // calling openWindow("") which does nothing and looks like a dead notification.
  const url = safeUrl(data.url) || "./index.html";
  event.waitUntil((async () => {
    // Focus an open copy rather than stacking tabs every time a push arrives.
    const all = await clients.matchAll({ type: "window",
                                         includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes("index.html") && "focus" in c && !safeUrl(data.url)) {
        return c.focus();
      }
    }
    return clients.openWindow(url);
  })());
});
