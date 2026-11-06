/* Primstav – service worker: instalação (PWA), tela offline e notificações push (FCM). */
const VERSION = 'primstav-v9';
const PRECACHE = ['/offline.html', '/logo.png', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/badge-96.png'];
const ICON = '/icons/icon-192.png';   // logo que aparece na notificação
const BADGE = '/icons/badge-96.png';  // ícone pequeno da barra de status (Android)

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Páginas: sempre da rede (para não mostrar agenda velha); sem internet, mostra a tela offline.
// Imagens/ícones do próprio site: cache primeiro.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // Firebase, Google, etc. passam direto
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
    return;
  }
  if (/\.(png|jpg|jpeg|svg|webp|ico)$/i.test(url.pathname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); return res;
    })));
  }
});

// ===== Notificações push =====
// O servidor envia só "data" (title, body, tag, url, tipo). Aqui montamos a notificação com a logo.
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (_) { payload = {}; }
  const d = payload.data || payload.notification || payload || {};
  const title = d.title || 'Primstav';
  const options = {
    body: d.body || '',
    icon: d.icon || ICON,
    badge: BADGE,
    tag: d.tag || undefined,           // mesma tag substitui a notificação anterior (evita duplicar)
    renotify: !!d.tag,
    data: { url: d.url || '/painel_do_profissional.html', tipo: d.tipo || '' },
    vibrate: [120, 60, 120],
    requireInteraction: d.tipo === 'sinal_expirando'
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/painel_do_profissional.html', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.startsWith(self.location.origin) && 'focus' in c) {
          return c.focus().then((w) => (w && 'navigate' in w && w.url !== target ? w.navigate(target) : w));
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
