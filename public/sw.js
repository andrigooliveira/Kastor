/* Kastor Service Worker — mínimo pra habilitar PWA install.
   Não faz cache offline ainda; só existe pra satisfazer o critério de
   "installable app" do Chrome/Edge (manifest + SW registrado). Evolui pra
   cache-first em assets estáticos (/css, /js, /vendor) quando quiser suporte
   offline básico. */

const SW_VERSION = 'kastor-2026-07-22';

self.addEventListener('install', event => {
  // Ativa imediatamente sem esperar as abas antigas fecharem.
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  // Assume controle das abas abertas assim que ativa.
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  // Pass-through — a rede resolve tudo. Handler existe só pra o browser
  // reconhecer o SW como funcional (requisito do install prompt).
});
