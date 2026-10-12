// bell's own app was retired on 2026-10-12 (plan item 36). A browser that still has its
// service worker drops it at the next update check: the list and its alerts are at
// https://grinduni.com/openings/, and nothing is pushed to this address any more.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.registration.unregister()));
