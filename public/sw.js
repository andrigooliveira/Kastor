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

const SW_VERSION   = '2026-07-31a';
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

self.addEventListener('fetch', event => {
  const req = event.request;

  // Só GET é cacheável; POST/PUT/DELETE passam direto.
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }

  // Só mesma origem — não intercepta Google Fonts, CDNs, etc.
  if (url.origin !== self.location.origin) return;

  // API (inclui o SSE /api/stream): sempre rede, nunca cache.
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
