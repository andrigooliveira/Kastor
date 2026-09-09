/* ═══════════════════════════════════════════════════════════════════════
   boot.js — arquivo mínimo carregado ANTES do app.js
   Responsabilidades:
     1) Aplicar o tema salvo (light/dark) antes de renderizar qualquer coisa
        — evita flash de tema errado.
     2) Detectar rota /reset/<token> → mostrar tela de reset (não precisa app).
     3) Verificar sessão via /api/me. Se logado, carregar app.js + style.css e
        entregar o `me` pré-carregado (evita duplo fetch).
     4) Se deslogado, mostrar tela de login e hookar doLogin/doResetPassword/
        showForgotPassword/loginWithDiscord. Tudo local — a maior parte do
        app não precisa parsear até o usuário autenticar.

   Por que existe:
     app.js tem ~30k linhas. Quem tá deslogado hoje espera parse+eval de tudo
     antes de ver o form de login. Este boot.js tem ~180 linhas — carrega e
     renderiza instantâneo. Impacto real em TTI/LCP no cold load e no reset.
   ═══════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // Versão pro cache-bust dos assets pesados (bate com o v= do HTML).
  const ASSET_VERSION = document.currentScript?.src?.match(/[?&]v=([^&]+)/)?.[1] || '';
  const CSS_URL = '/css/style.css' + (ASSET_VERSION ? '?v=' + ASSET_VERSION : '');
  const APP_URL = '/js/app.js' + (ASSET_VERSION ? '?v=' + ASSET_VERSION : '');
  const LUCIDE_URL = '/vendor/lucide.min.js';

  // ── KILL SWITCH ────────────────────────────────────────────────────────
  // Se `?legacy=1` na URL OU localStorage.kastor-legacy-boot === '1',
  // carrega style.css + app.js DIRETO (comportamento pré-split), pulando
  // todo o resto do boot.js. Uso em incidente: abra a app com ?legacy=1
  // uma vez — a flag persiste em localStorage e todas as próximas visitas
  // usam o caminho antigo até você fazer ?legacy=0 (ou limpar storage).
  try {
    const q = new URLSearchParams(location.search);
    const qLegacy = q.get('legacy');
    if (qLegacy === '1') localStorage.setItem('kastor-legacy-boot', '1');
    else if (qLegacy === '0') localStorage.removeItem('kastor-legacy-boot');
    if (localStorage.getItem('kastor-legacy-boot') === '1') {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = CSS_URL;
      document.head.appendChild(link);
      const lucide = document.createElement('script');
      lucide.src = LUCIDE_URL;
      lucide.onload = () => {
        const app = document.createElement('script');
        app.src = APP_URL;
        document.body.appendChild(app);
      };
      document.body.appendChild(lucide);
      // Log visível pro dev saber que o modo legacy está ativo.
      console.warn('[boot] modo legacy ativo — app.js carregado direto. Use ?legacy=0 pra voltar ao boot rápido.');
      return; // NÃO executa o restante do boot.js
    }
  } catch {}

  // ── Tema — aplica ANTES de renderizar. Evita flash. ───────────────────
  try {
    const theme = localStorage.getItem('kastor-theme') || 'dark';
    if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
  } catch {}

  // Tela de login usa fundo claro sempre (independente do tema do app),
  // então força o logo preto. O HTML default é branco.
  try {
    document.querySelectorAll('#login-screen .login-logo img, #reset-screen .login-logo img').forEach(img => {
      img.setAttribute('src', '/rework_preto.svg');
    });
  } catch {}

  // ── Helpers mínimos ───────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }

  async function api(path, method, body) {
    const res = await fetch('/api' + path, {
      method: method || 'GET',
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error((data && data.error) || 'Erro de rede');
    return data;
  }

  // Carrega style.css + lucide + app.js em paralelo (CSS bloqueia render, mas
  // JS não). O app.js roda seu próprio `boot()` — passamos `me` pré-carregado
  // via window.__preloadedMe pra ele pular o /api/me.
  let _appLoading = null;
  function loadFullApp(preloadedMe) {
    if (_appLoading) return _appLoading;
    if (preloadedMe) window.__preloadedMe = preloadedMe;

    // CSS
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_URL;
    document.head.appendChild(link);

    // JS (lucide primeiro, app.js depois — app.js chama lucide.createIcons)
    _appLoading = new Promise((resolve, reject) => {
      const lucide = document.createElement('script');
      lucide.src = LUCIDE_URL;
      lucide.onload = () => {
        const app = document.createElement('script');
        app.src = APP_URL;
        app.onload = resolve;
        app.onerror = reject;
        document.body.appendChild(app);
      };
      lucide.onerror = reject;
      document.body.appendChild(lucide);
    });
    return _appLoading;
  }

  // ── Tela de login: doLogin, doLogout, esqueci senha ───────────────────
  async function doLogin() {
    const username = $('login-username').value.trim();
    const password = $('login-password').value;
    const err = $('login-error');
    err.textContent = '';
    if (!username || !password) { err.textContent = 'Informe usuário e senha.'; return; }
    try {
      const data = await api('/login', 'POST', { username, password });
      // Sessão emitida via cookie. Carrega app.js com o `me` já resolvido.
      await loadFullApp(data.user);
    } catch (e) {
      err.textContent = e.message || 'Erro ao entrar';
    }
  }

  // Reset de senha (URL /reset/<token>)
  let _resetToken = null;
  function showResetScreen(token) {
    _resetToken = token;
    $('login-screen').style.display = 'none';
    const rs = $('reset-screen');
    rs.classList.add('open');
    setTimeout(() => { const i = $('reset-new-pass'); if (i) i.focus(); }, 60);
  }

  async function doResetPassword() {
    const p1 = $('reset-new-pass').value;
    const p2 = $('reset-confirm-pass').value;
    const err = $('reset-error');
    err.textContent = '';
    if (!p1 || p1.length < 6) { err.textContent = 'A senha precisa ter pelo menos 6 caracteres.'; return; }
    if (p1 !== p2) { err.textContent = 'As senhas não conferem.'; return; }
    try {
      await api('/reset-password', 'POST', { token: _resetToken, newPassword: p1 });
      history.replaceState(null, '', '/');
      location.reload();
    } catch (e) {
      err.textContent = e.message || 'Erro ao redefinir senha.';
    }
  }

  // "Esqueci minha senha" — usa prompt nativo (barato, correto). O fluxo
  // acabado (com showPrompt do design system) vive no app.js; aqui é o
  // fallback pré-login, sem custo de baixar 30k linhas pra digitar um email.
  async function showForgotPassword() {
    const email = window.prompt('Informe o e-mail cadastrado no seu perfil. Se houver conta vinculada, vamos enviar um link para definir uma nova senha.');
    if (!email || !email.trim()) return;
    try {
      await api('/forgot-password', 'POST', { email: email.trim() });
      alert('Se o e-mail estiver cadastrado, você vai receber as instruções em alguns minutos. Confira também o spam.');
    } catch (e) {
      alert(e.message || 'Erro ao enviar');
    }
  }

  // Discord OAuth — redirect direto, sem depender do app.js.
  function loginWithDiscord() { window.location.href = '/api/auth/discord/start'; }

  // Processa retorno do callback OAuth do Discord — ?discord=... na URL.
  // Se veio sucesso (logged-in/linked), deixa o app processar; se veio erro,
  // mostra na tela de login.
  function handleDiscordCallbackQuery() {
    const q = new URLSearchParams(location.search);
    const status = q.get('discord');
    if (!status || status === 'error') {
      if (status === 'error') {
        const reason = q.get('reason') || '';
        const map = {
          'not-configured':  'O login com Discord não está habilitado neste servidor.',
          'missing-params':  'O Discord não devolveu os parâmetros esperados. Tente de novo.',
          'invalid-state':   'Sessão de OAuth expirou (mais de 10 min). Tente de novo.',
          'exchange-failed': 'Falha ao validar o retorno do Discord. Tente de novo em alguns segundos.',
          'no-account':      'Nenhuma conta reWork está vinculada a esse Discord. Peça pra alguém da coordenação vincular seu ID, ou entre com usuário/senha.',
          'already-linked':  'Esse Discord já está vinculado a outra conta reWork.',
          'user-not-found':  'Usuário não encontrado. Faça login de novo e tente vincular.'
        };
        const el = $('login-error');
        if (el) el.textContent = map[reason] || 'Não foi possível concluir o login com Discord.';
        history.replaceState(null, '', location.pathname);
      }
      return false;
    }
    // logged-in/linked: mantém a query, app.js decide o que fazer.
    return true;
  }

  // ── Expõe funções que os `onclick=` do HTML esperam ───────────────────
  window.$ = window.$ || $;
  window.doLogin = doLogin;
  window.doResetPassword = doResetPassword;
  window.showForgotPassword = showForgotPassword;
  window.loginWithDiscord = loginWithDiscord;

  // ── Boot flow ─────────────────────────────────────────────────────────
  (async function boot() {
    // Reset de senha via link do email
    const resetMatch = location.pathname.match(/^\/reset\/([A-Za-z0-9_-]+)$/);
    if (resetMatch) {
      showResetScreen(resetMatch[1]);
      return;
    }

    handleDiscordCallbackQuery();

    // Tenta /api/me — se ok, já carrega o app com o user pré-carregado.
    try {
      const me = await api('/me');
      // Some com o login antes de carregar app.js pra evitar flash.
      const ls = $('login-screen'); if (ls) ls.style.display = 'none';
      await loadFullApp(me);
    } catch {
      // Deslogado — deixa a tela de login visível. O app.js NÃO carrega até
      // o user submeter o form.
      const u = $('login-username'); if (u) setTimeout(() => u.focus(), 100);
    }
  })();
})();
