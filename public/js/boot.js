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
      // No modo legacy o overlay some assim que app.js termina — app.js chama
      // hideBootLoading? via window. Se não estiver disponível, fallback pós 2s.
      window.hideBootLoading = window.hideBootLoading || function () {
        const el = document.getElementById('app-loading-screen');
        if (el) { el.classList.add('is-hidden'); setTimeout(() => el.style.display = 'none', 400); }
      };
      setTimeout(() => { try { window.hideBootLoading(); } catch {} }, 2500);
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
    document.querySelectorAll('#login-screen .login-logo img, #reset-screen .login-logo img, #invite-screen .login-logo img').forEach(img => {
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
    if (!res.ok) throw Object.assign(new Error((data && data.error) || 'Erro de rede'), { status: res.status, data });
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

  // ── Overlay de loading ───────────────────────────────────────────────
  // Início: overlay VISÍVEL (default HTML). Some quando o app.js chama
  // hideBootLoading() no fim de enterApp(), ou aqui quando decidimos que
  // vamos mostrar a tela de login em vez do app.
  //
  // Tempo mínimo visível é parametrizável — showBootLoading(ms) reinicia
  // o timer e força o overlay a ficar pelo menos `ms` desde ali. Default 1s
  // pro cold load; pós-login usa 2s (feedback deliberado da autenticação).
  const DEFAULT_MIN_LOADING_MS = 1000;
  let _minLoadingMs = DEFAULT_MIN_LOADING_MS;
  let _loadingHideT = null;
  let _loadingShownAt = Date.now(); // considera o próprio pageload
  function showBootLoading(minMs) {
    const el = $('app-loading-screen');
    if (!el) return;
    if (_loadingHideT) { clearTimeout(_loadingHideT); _loadingHideT = null; }
    _minLoadingMs = typeof minMs === 'number' && minMs >= 0 ? minMs : DEFAULT_MIN_LOADING_MS;
    _loadingShownAt = Date.now();
    el.style.display = '';
    // rAF garante que remover a classe cause transição de opacidade.
    requestAnimationFrame(() => el.classList.remove('is-hidden'));
  }
  function _actuallyHideBootLoading() {
    const el = $('app-loading-screen');
    if (!el) return;
    el.classList.add('is-hidden');
    if (_loadingHideT) clearTimeout(_loadingHideT);
    // Duração do fade bate com a transição CSS (--boot-fade-ms). Se subir aqui
    // sem subir lá, o `display:none` cortaria antes do fade acabar.
    _loadingHideT = setTimeout(() => { el.style.display = 'none'; }, 220);
  }
  function hideBootLoading() {
    const elapsed = Date.now() - _loadingShownAt;
    const remaining = _minLoadingMs - elapsed;
    if (remaining > 0) {
      if (_loadingHideT) clearTimeout(_loadingHideT);
      _loadingHideT = setTimeout(_actuallyHideBootLoading, remaining);
    } else {
      _actuallyHideBootLoading();
    }
  }
  window.showBootLoading = showBootLoading;
  window.hideBootLoading = hideBootLoading;

  // Mostra a tela de login (que começa oculta). Some com o overlay depois
  // que ela já está no DOM — evita flash branco.
  function showLoginScreen() {
    const ls = $('login-screen');
    if (ls) ls.classList.add('is-visible');
    hideBootLoading();
  }

  // ── Tela de login: doLogin, doLogout, esqueci senha ───────────────────
  async function doLogin() {
    const username = $('login-username').value.trim();
    const password = $('login-password').value;
    const err = $('login-error');
    err.textContent = '';
    if (!username || !password) { err.textContent = 'Informe seu e-mail (ou usuário) e a senha.'; return; }
    try {
      const data = await api('/login', 'POST', { username, password });
      // Verificação em duas etapas: a senha certa só abre o segundo passo.
      if (data.twoFactor) { showLogin2fa(data.twoFactor); return; }
      // Overlay obrigatório de 2s pós-login (feedback deliberado da autenticação).
      showBootLoading(2000);
      // Sessão emitida via cookie. Carrega app.js com o `me` já resolvido
      // (ou a tela de e-mail obrigatório, se a conta ainda não vinculou).
      await enterAfterAuth(data.user);
    } catch (e) {
      err.textContent = e.message || 'Erro ao entrar';
    }
  }

  // Reset de senha (URL /reset/<token>)
  let _resetToken = null;
  function showResetScreen(token) {
    _resetToken = token;
    const ls = $('login-screen'); if (ls) ls.classList.remove('is-visible');
    const rs = $('reset-screen');
    rs.classList.add('open');
    setTimeout(() => { const i = $('reset-new-pass'); if (i) i.focus(); }, 60);
    hideBootLoading();
  }

  async function doResetPassword() {
    const p1 = $('reset-new-pass').value;
    const p2 = $('reset-confirm-pass').value;
    const err = $('reset-error');
    err.textContent = '';
    if (!p1 || p1.length < 8) { err.textContent = 'A senha precisa ter pelo menos 8 caracteres.'; return; }
    if (p1 !== p2) { err.textContent = 'As senhas não conferem.'; return; }
    try {
      await api('/reset-password', 'POST', { token: _resetToken, newPassword: p1 });
      history.replaceState(null, '', '/');
      location.reload();
    } catch (e) {
      err.textContent = e.message || 'Erro ao redefinir senha.';
    }
  }

  // ── Convite (URL /convite/<token>) ──────────────────────────────────
  // Tela própria, sem o app.js: mostra quem convidou, pede nome, usuário e
  // senha, e ao aceitar a sessão já vem no cookie — entra direto.
  let _inviteToken = null;
  let _invitePassMin = 8;
  let _inviteExisting = false; // e-mail já tem conta: só confirma a senha
  const INVITE_USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
  const INVITE_PROBLEMS = {
    accepted: 'Convite já usado',
    revoked: 'Convite cancelado',
    expired: 'Convite vencido',
    account_exists: 'Você já tem conta',
    invalid: 'Convite não encontrado'
  };
  function inviteShow(which) {
    ['invite-loading', 'invite-form', 'invite-problem'].forEach(id => { const el = $(id); if (el) el.hidden = id !== which; });
  }
  function inviteProblem(status, text) {
    $('invite-problem-title').textContent = INVITE_PROBLEMS[status] || 'Convite indisponível';
    $('invite-problem-text').textContent = text || 'Não foi possível abrir este convite.';
    inviteShow('invite-problem');
  }
  function inviteInitials(name) {
    return String(name || '?').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
  }
  function inviteChip(text, muted) {
    const el = document.createElement('span');
    el.className = 'invite-chip' + (muted ? ' invite-chip--muted' : '');
    el.textContent = text;
    return el;
  }
  async function showInviteScreen(token) {
    _inviteToken = token;
    const ls = $('login-screen'); if (ls) ls.classList.remove('is-visible');
    $('invite-screen').classList.add('is-visible');
    hideBootLoading();
    inviteShow('invite-loading');
    let res, data = null;
    try {
      res = await fetch('/api/invites/public/' + encodeURIComponent(token), { credentials: 'same-origin' });
      try { data = await res.json(); } catch {}
    } catch {
      inviteProblem('', 'Sem conexão com o servidor. Confira sua internet e recarregue a página.');
      return;
    }
    if (!res.ok || !data) { inviteProblem(data && data.status, data && data.error); return; }

    const kicker = $('invite-kicker');
    kicker.textContent = '';
    const isOwnerInvite = data.access === 'Dono da organização';
    const b = document.createElement('b');
    b.textContent = isOwnerInvite ? 'Pedido aprovado' : (data.inviterName || 'A equipe');
    kicker.appendChild(b);
    if (!isOwnerInvite) kicker.appendChild(document.createTextNode(data.orgName ? ` convidou você para a ${data.orgName}` : ' convidou você'));
    _inviteExisting = !!data.accountExists;
    $('invite-title').textContent = isOwnerInvite
      ? `${data.orgName || 'Sua organização'} está pronta`
      : _inviteExisting ? `Entrar na ${data.orgName || 'organização'}` : 'Crie sua conta no reWork';
    $('invite-new-only').hidden = _inviteExisting;
    const note = $('invite-existing-note');
    note.hidden = !_inviteExisting;
    if (_inviteExisting) note.textContent = `Você já tem conta no reWork${data.existingName ? ` como ${data.existingName}` : ''}. Confirme sua senha para entrar ${data.orgName ? `na ${data.orgName}` : 'na organização'}; ela aparece no seletor de organizações.`;
    $('invite-password-label').textContent = _inviteExisting ? 'Sua senha do reWork' : 'Senha';
    const passEl = $('invite-password');
    passEl.setAttribute('autocomplete', _inviteExisting ? 'current-password' : 'new-password');
    $('invite-submit').textContent = _inviteExisting ? 'Entrar na organização' : (isOwnerInvite ? 'Criar conta e começar' : 'Criar conta e entrar');
    const av = $('invite-avatar');
    if (data.access === 'Dono da organização') {
      av.style.backgroundImage = 'url("/rework_logo.svg")';
      av.style.backgroundColor = '#f3ecff';
      av.style.backgroundSize = '60%';
      av.textContent = '';
    } else if (data.inviterAvatar && /^\/uploads\/[\w.-]+$/.test(data.inviterAvatar)) {
      av.style.backgroundImage = `url("${data.inviterAvatar}")`;
      av.textContent = '';
    } else {
      av.textContent = inviteInitials(data.inviterName);
    }
    const meta = $('invite-meta');
    meta.textContent = '';
    if (data.access) meta.appendChild(inviteChip(data.access));
    (data.squads || []).forEach(n => meta.appendChild(inviteChip(n, true)));
    $('invite-email').textContent = data.email;
    $('invite-name').value = data.name || '';
    $('invite-username').value = data.suggestedUsername || '';
    _invitePassMin = data.passwordMin || 8;
    passEl.placeholder = _inviteExisting ? '' : `Mínimo de ${_invitePassMin} caracteres`;
    inviteShow('invite-form');
    setTimeout(() => { const f = _inviteExisting || $('invite-name').value ? passEl : $('invite-name'); if (f) f.focus(); }, 60);
  }
  function inviteFieldError(field, msg) {
    const map = { name: 'invite-name', username: 'invite-username', password: 'invite-password', terms: 'invite-terms' };
    const el = map[field] && $(map[field]);
    if (el) { el.classList.add('is-invalid'); if (field !== 'terms') el.focus(); }
    $('invite-error').textContent = msg;
  }
  async function doAcceptInvite() {
    const err = $('invite-error');
    const btn = $('invite-submit');
    err.textContent = '';
    ['invite-name', 'invite-username', 'invite-password', 'invite-terms'].forEach(id => $(id).classList.remove('is-invalid'));
    const body = {
      name: $('invite-name').value.trim(),
      username: $('invite-username').value.trim().toLowerCase(),
      password: $('invite-password').value,
      acceptTerms: $('invite-terms').checked
    };
    if (_inviteExisting) {
      if (!body.password) return inviteFieldError('password', 'Digite sua senha do reWork.');
    } else {
      if (!body.name) return inviteFieldError('name', 'Informe seu nome.');
      if (!INVITE_USERNAME_RE.test(body.username)) return inviteFieldError('username', 'Use de 3 a 32 caracteres: letras minúsculas, números, ponto, hífen ou sublinhado.');
      if (body.password.length < _invitePassMin) return inviteFieldError('password', `A senha precisa ter pelo menos ${_invitePassMin} caracteres.`);
    }
    if (!body.acceptTerms) return inviteFieldError('terms', 'Aceite os Termos e a Política de Privacidade para continuar.');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = _inviteExisting ? 'Entrando…' : 'Criando sua conta…';
    let res, data = null;
    try {
      res = await fetch(`/api/invites/public/${encodeURIComponent(_inviteToken)}/${_inviteExisting ? 'join' : 'accept'}`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      try { data = await res.json(); } catch {}
    } catch {
      btn.disabled = false; btn.textContent = label;
      err.textContent = 'Sem conexão com o servidor. Tente de novo.';
      return;
    }
    if (!res.ok) {
      btn.disabled = false; btn.textContent = label;
      if (data && data.field) return inviteFieldError(data.field, data.error);
      if (data && data.status) return inviteProblem(data.status, data.error);
      err.textContent = (data && data.error) || 'Não foi possível criar a conta.';
      return;
    }
    history.replaceState(null, '', '/');
    $('invite-screen').classList.remove('is-visible');
    // Conta com verificação em duas etapas: já está na organização, mas entra
    // pelo login normal (senha + código).
    if (data.loginRequired) {
      showLoginScreen();
      const u = $('login-username'); if (u && data.user) u.value = data.user.email || data.user.username || '';
      const le = $('login-error'); if (le) { le.textContent = 'Pronto, você entrou na organização. Agora entre com a sua senha e o código.'; le.classList.add('is-ok'); }
      setTimeout(() => { const p = $('login-password'); if (p) p.focus(); }, 80);
      return;
    }
    // Conta criada e sessão aberta (cookie): entra no app.
    showBootLoading(1200);
    await enterAfterAuth(data.user);
  }
  function toggleInvitePassword() {
    const input = $('invite-password');
    const btn = $('invite-pass-toggle');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = show ? 'Ocultar' : 'Mostrar';
    btn.setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
    input.focus();
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
          'no-account':      'Nenhuma conta reWork está vinculada a esse Discord. Entre com e-mail e senha e vincule o Discord no seu perfil. Se recebeu um convite, use o link do e-mail.',
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
  window.doAcceptInvite = doAcceptInvite;
  window.toggleInvitePassword = toggleInvitePassword;

  // ── Verificação em duas etapas (segundo passo do login) ────────────────
  // Senha (ou Discord) certa → ticket; aqui a pessoa digita o código do
  // e-mail ou do app (ou um código de recuperação) e só então entra.
  let _l2 = null;
  let _l2ResendT = null;
  function showLogin2fa(info) {
    _l2 = { ...info, recovery: false };
    const ls = $('login-screen'); if (ls) ls.classList.add('is-visible');
    $('login-main').hidden = true;
    $('login-2fa').hidden = false;
    renderLogin2fa();
    hideBootLoading();
  }
  function renderLogin2fa() {
    const email = _l2.method === 'email';
    const rec = _l2.recovery;
    $('l2-title').textContent = rec ? 'Use um código de recuperação' : email ? 'Digite o código do e-mail' : 'Digite o código do app';
    $('l2-text').innerHTML = rec
      ? 'Digite um dos códigos de recuperação que você guardou ao ativar o app. Cada um vale uma vez.'
      : email ? 'Mandamos um código de 6 dígitos para <b></b>. Ele vale por 10 minutos.'
      : 'Abra o app autenticador (Google Authenticator, 1Password…) e digite o código de 6 dígitos do reWork.';
    const b = $('l2-text').querySelector('b'); if (b) b.textContent = _l2.emailHint || 'o seu e-mail';
    const input = $('l2-code');
    input.value = '';
    input.classList.toggle('is-recovery', rec);
    input.maxLength = rec ? 9 : 6;
    input.placeholder = rec ? 'xxxx-xxxx' : '000000';
    input.inputMode = rec ? 'text' : 'numeric';
    $('l2-error').textContent = '';
    $('l2-resend').hidden = !email;
    $('l2-recovery').hidden = email;
    $('l2-recovery').textContent = rec ? 'Usar o código do app' : 'Usar um código de recuperação';
    setTimeout(() => input.focus(), 60);
  }
  function toggleLogin2faRecovery() { if (_l2) { _l2.recovery = !_l2.recovery; renderLogin2fa(); } }
  function cancelLogin2fa(msg) {
    _l2 = null;
    $('login-2fa').hidden = true;
    $('login-main').hidden = false;
    const pw = $('login-password'); if (pw) pw.value = '';
    const le = $('login-error'); if (le) { le.textContent = msg || ''; le.classList.remove('is-ok'); }
    setTimeout(() => { const u = $('login-username'); if (u) (u.value ? pw : u).focus(); }, 60);
  }
  async function doLogin2fa() {
    if (!_l2) return;
    const code = ($('l2-code').value || '').trim();
    const err = $('l2-error');
    err.textContent = '';
    if (!_l2.recovery && !/^\d{6}$/.test(code.replace(/\s/g, ''))) { err.textContent = 'Digite os 6 números do código.'; return; }
    if (_l2.recovery && code.replace(/[^a-z0-9]/gi, '').length < 8) { err.textContent = 'Digite o código de recuperação completo.'; return; }
    const btn = $('l2-submit');
    btn.disabled = true; btn.textContent = 'Conferindo…';
    try {
      const r = await api('/login/2fa', 'POST', { ticket: _l2.ticket, code, recovery: _l2.recovery || undefined });
      if (r.usedRecovery) {
        const left = r.user && r.user.twoFactor ? r.user.twoFactor.recoveryLeft : 0;
        try { sessionStorage.setItem('rw-email-notice', JSON.stringify({ ok: true, text: `Você usou um código de recuperação. ${left === 1 ? 'Resta 1' : `Restam ${left}`}. Gere novos em Perfil › Segurança se precisar.` })); } catch {}
      }
      _l2 = null;
      history.replaceState(null, '', '/');
      showBootLoading(1200);
      await enterAfterAuth(r.user);
    } catch (e) {
      if (e.status === 410 || (e.data && e.data.code === 'expired')) return cancelLogin2fa(e.message);
      err.textContent = e.message || 'Não foi possível conferir o código.';
      $('l2-code').select();
    } finally {
      btn.disabled = false; btn.textContent = 'Entrar';
    }
  }
  async function resendLogin2fa() {
    if (!_l2) return;
    const link = $('l2-resend');
    const err = $('l2-error');
    link.setAttribute('aria-disabled', 'true');
    try {
      await api('/login/2fa/resend', 'POST', { ticket: _l2.ticket });
      err.textContent = 'Enviamos um código novo.';
      err.classList.add('is-ok');
      let left = 30;
      clearInterval(_l2ResendT);
      link.textContent = `Reenviar código (${left}s)`;
      _l2ResendT = setInterval(() => {
        left--;
        if (left <= 0) { clearInterval(_l2ResendT); link.textContent = 'Reenviar código'; link.removeAttribute('aria-disabled'); }
        else link.textContent = `Reenviar código (${left}s)`;
      }, 1000);
    } catch (e) {
      link.removeAttribute('aria-disabled');
      if (e.status === 410) return cancelLogin2fa(e.message);
      err.classList.remove('is-ok');
      err.textContent = e.message || 'Não foi possível reenviar.';
    }
  }
  window.doLogin2fa = doLogin2fa;
  window.resendLogin2fa = resendLogin2fa;
  window.toggleLogin2faRecovery = toggleLogin2faRecovery;
  window.cancelLogin2fa = cancelLogin2fa;

  // ── E-mail obrigatório (depois do prazo) ─────────────────────────────
  // Conta sem e-mail confirmado entra, mas só vê esta tela — o app nem
  // carrega (e o servidor recusa o resto da API).
  let _egMe = null;
  function showEmailGate(me) {
    _egMe = me;
    const ls = $('login-screen'); if (ls) ls.classList.remove('is-visible');
    $('eg-who').textContent = me.name || me.username || '';
    const pend = me.pendingEmail;
    if (pend) { egShowSent(pend.email); }
    else egShowForm();
    $('email-gate').classList.add('is-visible');
    hideBootLoading();
  }
  function egShowForm() {
    const me = _egMe;
    $('eg-sent').hidden = true;
    $('eg-form').hidden = false;
    $('eg-title').textContent = me.email ? 'Confirme seu e-mail para continuar' : 'Vincule um e-mail para continuar';
    const d = new Date(me.emailDeadline);
    const quando = isNaN(d) ? '' : ` em ${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}`;
    $('eg-text').innerHTML = (me.email
      ? `O prazo para confirmar o e-mail das contas do reWork acabou${quando}. Sua conta tem o e-mail <b></b>: envie o link de confirmação e abra o e-mail. Assim que confirmar, tudo volta ao normal.`
      : `O prazo para vincular um e-mail às contas do reWork acabou${quando}. Informe o seu e-mail para receber o link de confirmação. Assim que confirmar, tudo volta ao normal.`);
    const b = $('eg-text').querySelector('b'); if (b) b.textContent = me.email;
    $('eg-email').value = (me.pendingEmail && me.pendingEmail.email) || me.email || '';
    $('eg-pass').value = '';
    $('eg-error').textContent = '';
    egSync();
    setTimeout(() => { const i = $('eg-email').value ? ($('eg-pass-wrap').hidden ? $('eg-submit') : $('eg-pass')) : $('eg-email'); if (i) i.focus(); }, 60);
  }
  function egShowSent(addr) {
    $('eg-form').hidden = true;
    $('eg-sent').hidden = false;
    $('eg-sent-text').innerHTML = 'Mandamos um link para <b></b>. Abra o e-mail, toque em <b>Confirmar e-mail</b> e depois volte aqui. O link vale 24 horas; se não chegar em alguns minutos, veja no spam.';
    $('eg-sent-text').querySelector('b').textContent = addr;
  }
  // Senha só quando é um e-mail diferente do da conta (e a conta tem senha).
  function egSync() {
    const me = _egMe || {};
    const typed = ($('eg-email').value || '').trim().toLowerCase();
    const same = !!me.email && typed === String(me.email).toLowerCase();
    $('eg-pass-wrap').hidden = same || me.hasPassword === false;
  }
  async function egSubmit() {
    const email = ($('eg-email').value || '').trim();
    const err = $('eg-error');
    err.textContent = '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err.textContent = 'Confira o e-mail. Ele precisa ter o formato nome@empresa.com.'; $('eg-email').focus(); return; }
    const needPass = !$('eg-pass-wrap').hidden;
    const password = $('eg-pass').value;
    if (needPass && !password) { err.textContent = 'Digite a sua senha do reWork.'; $('eg-pass').focus(); return; }
    const btn = $('eg-submit');
    btn.disabled = true; btn.textContent = 'Enviando…';
    try {
      const r = await api('/me/email', 'POST', needPass ? { email, password } : { email });
      if (r && r.user) _egMe = { ..._egMe, ...r.user };
      egShowSent(email.toLowerCase());
    } catch (e) {
      err.textContent = e.message || 'Não foi possível enviar.';
    } finally {
      btn.disabled = false; btn.textContent = 'Enviar link de confirmação';
    }
  }
  async function egLogout() {
    try { await api('/logout', 'POST'); } catch {}
    location.href = '/';
  }
  // /api/me completo (com os campos do e-mail) e decide: tela restrita ou app.
  async function enterAfterAuth(me) {
    if (!me || me.emailDeadline === undefined) me = await api('/me');
    if (me && me.emailRequired) { showEmailGate(me); return; }
    await loadFullApp(me);
  }
  window.egSubmit = egSubmit;
  window.egSync = egSync;
  window.egShowForm = egShowForm;
  window.egLogout = egLogout;

  // ── Confirmação de e-mail (URL /confirmar-email/<token>) ─────────────────
  // Confirma e segue o boot normal: logado, abre o app com um aviso; senão,
  // mostra o resultado na tela de login.
  async function confirmEmailFromLink(token) {
    let notice;
    try {
      const r = await api('/email/confirm', 'POST', { token });
      notice = { ok: true, text: `E-mail ${r.email} confirmado. Você já pode entrar com ele, e o login passa a pedir também um código enviado para esse e-mail.` };
    } catch (e) {
      notice = { ok: false, text: e.message || 'Não foi possível confirmar o e-mail.' };
    }
    try { sessionStorage.setItem('rw-email-notice', JSON.stringify(notice)); } catch {}
    history.replaceState(null, '', '/');
    return notice;
  }

  // ── Boot flow ─────────────────────────────────────────────────────────
  (async function boot() {
    const twoFaTicket = new URLSearchParams(location.search).get('dois-fatores');
    if (twoFaTicket) {
      history.replaceState(null, '', '/');
      try { showLogin2fa(await api('/login/2fa/' + encodeURIComponent(twoFaTicket))); }
      catch (e) { showLoginScreen(); const le = $('login-error'); if (le) le.textContent = e.message || 'Entre de novo.'; }
      return;
    }
    const emailMatch = location.pathname.match(/^\/confirmar-email\/([A-Za-z0-9_-]+)$/);
    const emailNotice = emailMatch ? await confirmEmailFromLink(emailMatch[1]) : null;
    // Reset de senha via link do email
    const resetMatch = location.pathname.match(/^\/reset\/([A-Za-z0-9_-]+)$/);
    if (resetMatch) {
      showResetScreen(resetMatch[1]);
      return;
    }
    // Convite pra criar conta
    const inviteMatch = location.pathname.match(/^\/convite\/([A-Za-z0-9_-]+)$/);
    if (inviteMatch) {
      showInviteScreen(inviteMatch[1]);
      return;
    }

    handleDiscordCallbackQuery();

    // Tenta /api/me — se ok, já carrega o app com o user pré-carregado.
    // O overlay de loading fica visível o tempo todo (default do HTML) e o
    // app.js chama hideBootLoading() quando termina enterApp — evita flash
    // de login → app.
    try {
      const me = await api('/me');
      await enterAfterAuth(me);
    } catch {
      // Deslogado — revela a tela de login e some com o overlay.
      showLoginScreen();
      if (emailNotice) {
        const le = $('login-error');
        if (le) { le.textContent = emailNotice.text; le.classList.toggle('is-ok', !!emailNotice.ok); }
        try { sessionStorage.removeItem('rw-email-notice'); } catch {}
      }
      const u = $('login-username'); if (u) setTimeout(() => u.focus(), 100);
      // Prefetch dos assets pesados em background enquanto o user digita.
      // rel=prefetch tem prioridade baixa (não compete com o LCP do login),
      // mas garante que quando o Entrar for clicado, os bytes já estão em
      // cache — login → app fica quase instantâneo.
      try {
        setTimeout(() => {
          [
            { rel: 'prefetch', href: APP_URL, as: 'script' },
            { rel: 'prefetch', href: CSS_URL, as: 'style' },
            { rel: 'prefetch', href: LUCIDE_URL, as: 'script' },
          ].forEach(({ rel, href, as }) => {
            const el = document.createElement('link');
            el.rel = rel; el.href = href; el.as = as;
            document.head.appendChild(el);
          });
        }, 800); // esperar o LCP do login estabilizar antes de disparar prefetch
      } catch {}
    }
  })();
})();
