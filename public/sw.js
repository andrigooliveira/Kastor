/* reWork Service Worker — PWA "de verdade" com cache-first nos estáticos.
   Objetivo: abertura quase instantânea nas visitas seguintes + shell offline,
   sem nunca servir dado velho de API.

   Estratégia por tipo de requisição:
   - /api/*          → NUNCA intercepta (dado dinâmico e sensível a permissão;
                       inclui o SSE /api/stream). Vai direto pra rede.
   - /uploads/*      → passa direto (conteúdo de usuário, autenticado). Cada
                       upload tem filename único, então não há ganho em cachear
                       e evitamos guardar anexos potencialmente sensíveis no SW.
   - navegação (HTML)→ network-first com fallback pro shell cacheado. Garante que
                       o index.html novo (com ?v= atualizado) seja sempre online.
   - estáticos       → cache-first. A URL versionada (?v=YYYYMMDDx) já invalida
     (css/js/vendor/  sozinha entre deploys: URL nova = miss = busca na rede e
      svg/png/fontes) recacheia. Serve do disco na 2ª visita em diante.

   Update SILENCIOSO: skipWaiting() + clients.claim() fazem o SW novo assumir na
   hora; o usuário pega os assets novos no próximo reload, sem prompt. O activate
   limpa os caches de versões antigas pra não acumular lixo. */

const SW_VERSION   = '2026-10-01c';
const STATIC_CACHE = `rework-static-${SW_VERSION}`;

/* App shell mínimo pré-cacheado no install. Só recursos com URL estável (sem
   ?v=). css/js versionados são cacheados em runtime na 1ª visita — hardcodá-los
   aqui os deixaria presos numa versão. addAll tolera falha pra não travar o
   install se um recurso estiver indisponível no momento. */
const PRECACHE_URLS = [
  '/',
  '/favicon.png',
  '/manifest.json',
  '/rework_branco.svg',
  '/rework_preto.svg',
  '/rework_logo.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', event => {
  // Ativa imediatamente sem esperar as abas antigas fecharem (update silencioso).
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .catch(() => { /* offline no install ou recurso ausente — segue mesmo assim */ })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Remove caches de versões anteriores do reWork (inclui os antigos da era
    // Kastor — prefixo kastor-static-* — pra não deixar lixo/logos velhos).
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => (k.startsWith('rework-static-') || k.startsWith('kastor-static-')) && k !== STATIC_CACHE)
          .map(k => caches.delete(k))
    );
    // Assume controle das abas abertas já nesta ativação.
    await self.clients.claim();
  })());
});

const API_CACHE = 'rework-api-v1';
const OFFLINE_API = new Set(['/api/me', '/api/bootstrap', '/api/notifications', '/api/users', '/api/schedules']);
function _apiCacheKey(req, url) {
  const org = req.headers.get('X-Org-Id') || '';
  return new Request(url.origin + url.pathname + url.search + (url.search ? '&' : '?') + '__org=' + encodeURIComponent(org));
}
async function apiNetworkFirst(req, url) {
  const key = _apiCacheKey(req, url);
  try {
    const res = await fetch(req);
    if (res && res.status === 200) {
      const copy = res.clone();
      caches.open(API_CACHE).then(c => c.put(key, copy)).catch(() => {});
    }
    return res;
  } catch (err) {
    const cached = await caches.match(key, { cacheName: API_CACHE });
    if (!cached) throw err;
    const headers = new Headers(cached.headers);
    headers.set('X-Rw-Cache', '1');
    return new Response(await cached.blob(), { status: 200, headers });
  }
}
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'rw:logout') event.waitUntil(caches.delete(API_CACHE));
});

self.addEventListener('fetch', event => {
  const req = event.request;

  // Só GET é cacheável; POST/PUT/DELETE passam direto.
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }

  // Só mesma origem — não intercepta Google Fonts, CDNs, etc.
  if (url.origin !== self.location.origin) return;

  // Leitura sem internet: as poucas rotas que montam o app (sessão, dados,
  // notificações, pessoas) vão pra rede primeiro e, sem conexão, respondem
  // com a última cópia salva (marcada com X-Rw-Cache: 1). A chave inclui a
  // organização da aba (X-Org-Id). Só respostas 200 são guardadas; o logout
  // apaga tudo (mensagem rw:logout).
  if (OFFLINE_API.has(url.pathname)) {
    event.respondWith(apiNetworkFirst(req, url));
    return;
  }
  // Resto da API (inclui o SSE /api/stream): sempre rede, nunca cache.
  if (url.pathname.startsWith('/api/')) return;

  // Conteúdo de usuário autenticado: passa direto, sem cachear no SW.
  if (url.pathname.startsWith('/uploads/')) return;

  // Navegação (documento HTML) → network-first, fallback pro shell cacheado.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          // Atualiza o shell offline com a versão mais recente do index.
          const copy = res.clone();
          caches.open(STATIC_CACHE).then(c => c.put('/', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('/').then(r => r || caches.match(req)))
    );
    return;
  }

  // Manifesto do app → network-first: ícones/atalhos novos chegam sem esperar
  // o SW trocar de versão; offline cai no cache.
  if (url.pathname === '/manifest.json') {
    event.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(STATIC_CACHE).then(c => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Estáticos → cache-first com preenchimento em runtime.
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        // Cacheia só resposta OK de mesma origem (type 'basic').
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(STATIC_CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      });
    })
  );
});

/* ── PUSH ──
   O servidor manda { title, body, url, tag }. Mostra a notificação com o
   ícone do app e acende o selo no ícone da tela inicial (onde o sistema
   suporta). Tocar abre/foca o app já na demanda. */
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data && event.data.text() }; }
  const title = data.title || 'reWork';
  event.waitUntil((async () => {
    // App aberto e em primeiro plano: o sino do próprio app já avisa.
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some(w => w.focused && w.visibilityState === 'visible')) return;
    await Promise.all([
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      tag: data.tag || undefined,
      renotify: !!data.tag,
      actions: Array.isArray(data.actions) ? data.actions.slice(0, 2) : [],
      data: { url: data.url || '/', notificationId: data.notificationId || null },
    }),
      self.navigator && self.navigator.setAppBadge ? self.navigator.setAppBadge().catch(() => {}) : null,
    ]);
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const nd = event.notification.data || {};
  const url = new URL(nd.url || '/', self.location.origin);
  // "Avançar etapa": abre a demanda e o app dispara o Avançar (com o lembrete de apontar).
  if (event.action === 'next') url.searchParams.set('rwact', 'next');
  const target = url.href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (event.action === 'read') {
      // Marca como lida sem abrir o app; se ele estiver aberto, atualiza o sino.
      if (nd.notificationId) {
        await fetch('/api/notifications/' + encodeURIComponent(nd.notificationId) + '/read', { method: 'PUT', credentials: 'same-origin' }).catch(() => {});
      }
      wins.forEach(w => w.postMessage({ type: 'rw:notif-refresh' }));
      return;
    }
    const win = wins.find(w => new URL(w.url).origin === self.location.origin);
    if (win) {
      // App aberto: foca e pede pra ele navegar (sem recarregar tudo).
      await win.focus();
      win.postMessage({ type: 'rw:navigate', url: target });
      return;
    }
    await self.clients.openWindow(target);
  })());
});
