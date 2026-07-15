const CACHE = 'opg-v1';

function networkFirst(req, fallback) {
  return fetch(req)
    .then(res => {
      const c = caches.open(CACHE).then(cache => cache.put(req, res.clone()));
      return res;
    })
    .catch(() => caches.match(req).then(m => m || (fallback ? caches.match(fallback) : Response.error())));
}

function cacheFirst(req) {
  return caches.match(req).then(m => m || fetch(req));
}

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c =>
    c.addAll(['/', '/index.html', '/styles.css', '/app.js', '/icon-180.png', '/icon-192.png', '/icon-512.png'])
  ).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // API 请求不缓存，直接走网络
  if (url.pathname.startsWith('/api/')) return;

  // 页面导航：网络优先，离线回退到缓存首页
  if (req.mode === 'navigate') {
    e.respondWith(networkFirst(req, '/index.html'));
    return;
  }

  const p = url.pathname;
  // 关键代码文件：始终优先取网络最新版本，避免旧缓存
  if (p.endsWith('/app.js') || p.endsWith('/styles.css') || p.endsWith('.webmanifest')) {
    e.respondWith(networkFirst(req));
    return;
  }

  // 图标等静态资源：缓存优先
  e.respondWith(cacheFirst(req));
});
