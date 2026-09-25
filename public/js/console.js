/* ═════════════════════════════════════════════════════════════════════
   reWork Console — front-end (/console)
   SPA pequena em JS puro: entrada (senha + código do app autenticador),
   visão geral, organizações, lista de espera, superadmins e auditoria.
   Fala só com /api/console/* (sessão própria, cookie rework_console).
   ═════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const $app = document.getElementById('app');
  const state = { me: null, status: null, counts: null, charts: [], wl: { items: [], filter: 'new', selected: null } };

  /* ── Utilidades ── */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (name, cls) => `<i data-lucide="${name}"${cls ? ` class="${cls}"` : ''}></i>`;
  const paint = () => { try { window.lucide && lucide.createIcons(); } catch (_) {} };
  const nf = new Intl.NumberFormat('pt-BR');
  const num = (n) => nf.format(Number(n) || 0);
  const hrs = (n) => `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(Number(n) || 0)} h`;
  const initials = (n) => String(n || '?').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
  const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  function dateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  function rel(iso) {
    if (!iso) return 'nunca';
    const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
    if (s < 60) return 'agora';
    const m = Math.floor(s / 60); if (m < 60) return `há ${m} min`;
    const h = Math.floor(m / 60); if (h < 24) return `há ${h} h`;
    const d = Math.floor(h / 24); if (d < 30) return `há ${d} ${d === 1 ? 'dia' : 'dias'}`;
    const mo = Math.floor(d / 30); if (mo < 12) return `há ${mo} ${mo === 1 ? 'mês' : 'meses'}`;
    return `há ${Math.floor(d / 365)} ano(s)`;
  }
  function bytes(n) {
    if (n == null) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: v < 10 ? 1 : 0 }).format(v)} ${u[i]}`;
  }
  function duration(sec) {
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
  }

  async function api(path, opts = {}) {
    let res;
    try {
      res = await fetch('/api' + path, {
        method: opts.method || 'GET', credentials: 'same-origin',
        headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
        body: opts.body ? JSON.stringify(opts.body) : undefined
      });
    } catch {
      throw Object.assign(new Error('Sem conexão com o servidor.'), { status: 0 });
    }
    let data = null;
    try { data = await res.json(); } catch {}
    if (res.status === 401 && path.startsWith('/console/') && !opts.auth) {
      state.me = null;
      go('/console/entrar', true);
      throw Object.assign(new Error('Sessão expirada.'), { status: 401, silent: true });
    }
    if (!res.ok) throw Object.assign(new Error((data && data.error) || `Erro ${res.status}`), { status: res.status, data });
    return data;
  }
  function toast(msg, isError) {
    const box = document.getElementById('c-toasts');
    const el = document.createElement('div');
    el.className = 'c-toast' + (isError ? ' is-error' : '');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }
  async function copy(text, what) {
    try { await navigator.clipboard.writeText(text); toast(`${what || 'Texto'} copiado.`); }
    catch { toast('Não foi possível copiar.', true); }
  }
  function fail(e) { if (!e.silent) toast(e.message, true); }

  /* ── Rotas ── */
  function go(path, replace) {
    if (location.pathname + location.search !== path) history[replace ? 'replaceState' : 'pushState'](null, '', path);
    route();
  }
  window.addEventListener('popstate', route);
  document.addEventListener('click', (ev) => {
    const a = ev.target.closest('a[data-link]');
    if (!a || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
    ev.preventDefault();
    document.querySelector('.c-shell')?.classList.remove('is-menu-open');
    go(a.getAttribute('href'));
  });

  async function route() {
    state.charts = [];
    const p = location.pathname.replace(/\/+$/, '') || '/console';
    if (!state.status) {
      try { state.status = await api('/console/status', { auth: true }); }
      catch (e) { $app.innerHTML = authCard('Console indisponível', esc(e.message), ''); return; }
    }
    const act = p.match(/^\/console\/ativar\/([A-Za-z0-9_-]+)$/);
    if (act) return renderActivate(act[1]);
    const rst = p.match(/^\/console\/redefinir\/([A-Za-z0-9_-]+)$/);
    if (rst) return renderReset(rst[1]);
    if (p === '/console/recuperar' && !state.status.setupNeeded) return renderRecover();
    if (!state.me && state.status.signedIn !== false) {
      try { state.me = await api('/console/me', { auth: true }); } catch { state.me = null; }
      state.status.signedIn = !!state.me;
    }
    if (!state.me) {
      return renderLogin();
    }
    if (p === '/console/entrar' || p === '/console/configurar') return go('/console', true);
    const org = p.match(/^\/console\/organizacoes\/([\w-]+)$/);
    if (p === '/console') return pageOverview();
    if (p === '/console/organizacoes') return pageOrgs();
    if (org) return pageOrg(org[1]);
    if (p === '/console/lista-de-espera') return pageWaitlist();
    if (p === '/console/administradores') return pageAdmins();
    if (p === '/console/auditoria') return pageAudit();
    go('/console', true);
  }

  /* ═════════════ Entrada ═════════════ */
  function authCard(title, sub, body) {
    return `<div class="c-auth"><div class="c-auth-card">
      <div class="c-auth-brand"><img src="/rework_logo.svg" alt=""><span class="c-brand-name">reWork</span><span class="c-brand-tag">Console</span></div>
      <h1 class="c-auth-title">${title}</h1>
      ${sub ? `<p class="c-auth-sub">${sub}</p>` : ''}
      ${body}
    </div></div>`;
  }
  function fieldError(form, field, msg) {
    form.querySelectorAll('.is-invalid').forEach(el => el.classList.remove('is-invalid'));
    const input = field && form.querySelector(`[name="${field}"]`);
    if (input) { input.classList.add('is-invalid'); input.focus(); }
    form.querySelector('.c-error').textContent = msg || '';
  }
  function busy(btn, on, label) {
    if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || 'Aguarde…'; btn.disabled = true; }
    else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
  }

  function renderLogin() {
    if (location.pathname !== '/console/entrar') history.replaceState(null, '', '/console/entrar');
    $app.innerHTML = authCard('Entrar no console', 'Painel da plataforma. Acesso só para superadmins.', `
      <form id="f-login" novalidate>
        <div class="c-field"><label class="c-label" for="l-email">E-mail</label><input class="c-input" id="l-email" name="email" type="text" inputmode="email" autocomplete="username" autocapitalize="off" spellcheck="false" required></div>
        <div class="c-field"><label class="c-label" for="l-pass">Senha</label><input class="c-input" id="l-pass" name="password" type="password" autocomplete="current-password" required></div>
        <div class="c-error" role="alert"></div>
        <button class="c-btn c-btn--primary c-btn--block" type="submit">Continuar</button>
      </form>
      <p class="c-auth-foot"><a href="#" id="go-forgot">Esqueci a senha</a> · <a href="/console/recuperar" id="go-recover">Perdi o acesso</a></p>`);
    document.getElementById('go-forgot').addEventListener('click', (e) => { e.preventDefault(); renderForgot(); });
    document.getElementById('go-recover').addEventListener('click', (e) => { e.preventDefault(); history.pushState(null, '', '/console/recuperar'); renderRecover(); });
    const f = document.getElementById('f-login');
    setTimeout(() => f.email.focus(), 30);
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = f.querySelector('button[type=submit]');
      if (!f.email.value.trim() || !f.password.value) return fieldError(f, !f.email.value.trim() ? 'email' : 'password', 'Informe e-mail e senha.');
      busy(btn, true, 'Verificando…');
      try {
        const r = await api('/console/login', { method: 'POST', body: { email: f.email.value, password: f.password.value }, auth: true });
        if (r.step === 'done') afterVerify(r);
        else if (r.step === 'enroll') renderEnroll(r);
        else renderCode(r.ticket);
      } catch (e) { busy(btn, false); fieldError(f, 'password', e.message); }
    });
  }

  function codeForm(id, label) {
    return `<form id="${id}" novalidate>
      <div class="c-field"><label class="c-label" for="${id}-code">${label}</label>
        <input class="c-input c-code-input" id="${id}-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*" placeholder="000000"></div>
      <div class="c-error" role="alert"></div>
      <button class="c-btn c-btn--primary c-btn--block" type="submit">Confirmar</button>
    </form>`;
  }
  function bindCode(formId, ticket) {
    const f = document.getElementById(formId);
    const input = f.code;
    setTimeout(() => input.focus(), 30);
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(0, 6);
      if (input.value.length === 6) f.requestSubmit();
    });
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = f.querySelector('button[type=submit]');
      if (input.value.length !== 6) return fieldError(f, 'code', 'Digite os 6 números do app.');
      busy(btn, true, 'Confirmando…');
      try {
        const r = await api('/console/login/verify', { method: 'POST', body: { ticket, code: input.value }, auth: true });
        afterVerify(r);
      } catch (e) {
        busy(btn, false);
        if (e.data && e.data.restart) { toast(e.message, true); return renderLogin(); }
        input.value = '';
        fieldError(f, 'code', e.message);
      }
    });
  }
  function afterVerify(r) {
    state.me = r.admin; state.status = null;
    const enter = () => { history.replaceState(null, '', '/console'); route(); };
    if (r.recoveryCodes) return renderRecoveryCodes(r.recoveryCodes, enter);
    if (r.usedRecovery) {
      const left = r.admin.recoveryLeft;
      toast(left <= 3 ? `Código de recuperação usado. Restam ${left}. Gere novos em Superadmins.` : `Código de recuperação usado. Restam ${left}.`, left <= 3);
    }
    enter();
  }
  function renderCode(ticket) {
    $app.innerHTML = authCard('Código de verificação', 'Abra o app autenticador no celular e digite o código do reWork Console.', `
      ${codeForm('f-code', 'Código de 6 dígitos')}
      <p class="c-auth-foot"><a href="#" id="use-recovery">Perdi o celular: usar um código de recuperação</a><br><a href="/console/entrar" id="back-login">Voltar</a></p>`);
    document.getElementById('back-login').addEventListener('click', (e) => { e.preventDefault(); renderLogin(); });
    document.getElementById('use-recovery').addEventListener('click', (e) => { e.preventDefault(); renderRecoveryLogin(ticket); });
    bindCode('f-code', ticket);
  }
  function renderRecoveryLogin(ticket) {
    $app.innerHTML = authCard('Código de recuperação', 'Use um dos códigos que você guardou ao cadastrar o app. Cada código vale uma vez.', `
      <form id="f-rc" novalidate>
        <div class="c-field"><label class="c-label" for="rc-code">Código de recuperação</label>
          <input class="c-input mono" id="rc-code" name="code" autocomplete="off" spellcheck="false" placeholder="xxxx-xxxx" style="height:48px;font-size:18px;letter-spacing:.12em;text-align:center"></div>
        <div class="c-error" role="alert"></div>
        <button class="c-btn c-btn--primary c-btn--block" type="submit">Entrar</button>
      </form>
      <p class="c-auth-foot"><a href="#" id="back-code">Voltar para o código do app</a></p>`);
    document.getElementById('back-code').addEventListener('click', (e) => { e.preventDefault(); renderCode(ticket); });
    const f = document.getElementById('f-rc');
    setTimeout(() => f.code.focus(), 30);
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = f.querySelector('button[type=submit]');
      const code = f.code.value.trim();
      if (code.replace(/[^a-z0-9]/gi, '').length !== 8) return fieldError(f, 'code', 'O código tem 8 caracteres, no formato xxxx-xxxx.');
      busy(btn, true, 'Verificando…');
      try {
        const r = await api('/console/login/verify', { method: 'POST', body: { ticket, code }, auth: true });
        afterVerify(r);
      } catch (e) {
        busy(btn, false);
        if (e.data && e.data.restart) { toast(e.message, true); return renderLogin(); }
        fieldError(f, 'code', e.message);
      }
    });
  }
  /* Mostra os códigos de recuperação uma única vez (depois do cadastro do app
     ou ao gerar novos). `done` segue o fluxo quando a pessoa confirma. */
  function recoveryCodesHTML(codes) {
    return `<div class="c-codes">${codes.map(c => `<code>${esc(c)}</code>`).join('')}</div>
      <div class="c-actions" style="margin-bottom:16px">
        <button class="c-btn c-btn--sm" type="button" data-rc-copy>${icon('copy')}Copiar</button>
        <button class="c-btn c-btn--sm" type="button" data-rc-download>${icon('download')}Baixar .txt</button>
      </div>`;
  }
  function bindRecoveryCodes(root, codes) {
    const text = `reWork Console — códigos de recuperação\n${state.me ? state.me.email : ''}\nGerados em ${dateTime(new Date().toISOString())}\n\nCada código vale uma vez. Guarde num lugar seguro (gerenciador de senhas).\n\n${codes.join('\n')}\n`;
    root.querySelector('[data-rc-copy]').addEventListener('click', () => copy(codes.join('\n'), 'Códigos'));
    root.querySelector('[data-rc-download]').addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      a.download = 'rework-console-codigos-de-recuperacao.txt';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
  }
  function renderRecoveryCodes(codes, done) {
    $app.innerHTML = authCard('Guarde seus códigos de recuperação', 'Se perder o celular, cada um destes códigos substitui o código do app uma vez. Eles não aparecem de novo.', `
      ${recoveryCodesHTML(codes)}
      <label class="c-check"><input type="checkbox" id="rc-ok"> Guardei os códigos num lugar seguro</label>
      <button class="c-btn c-btn--primary c-btn--block" id="rc-continue" disabled>Entrar no console</button>`);
    paint();
    bindRecoveryCodes($app, codes);
    const ok = document.getElementById('rc-ok'), btn = document.getElementById('rc-continue');
    ok.addEventListener('change', () => { btn.disabled = !ok.checked; });
    btn.addEventListener('click', done);
  }

  function renderForgot() {
    const emailOn = state.status && state.status.emailEnabled;
    $app.innerHTML = authCard('Esqueci a senha', emailOn
      ? 'Mandamos um link para criar uma senha nova. O código do app autenticador continua sendo pedido na entrada.'
      : 'O envio de e-mail não está configurado neste servidor, então a senha não pode ser redefinida por e-mail.', emailOn ? `
      <form id="f-forgot" novalidate>
        <div class="c-field"><label class="c-label" for="fg-email">E-mail do console</label><input class="c-input" id="fg-email" name="email" type="email" autocomplete="username"></div>
        <div class="c-error" role="alert"></div>
        <button class="c-btn c-btn--primary c-btn--block" type="submit">Enviar link</button>
      </form>
      <p class="c-auth-foot"><a href="/console/entrar" data-back>Voltar</a></p>` : `
      <p class="c-auth-sub">Peça para outro superadmin gerar um novo link de ativação em <b>Superadmins</b>. Se você é o único, use a <a href="/console/recuperar" data-recover>recuperação pelo servidor</a>.</p>
      <p class="c-auth-foot"><a href="/console/entrar" data-back>Voltar</a></p>`);
    $app.querySelector('[data-back]').addEventListener('click', (e) => { e.preventDefault(); renderLogin(); });
    $app.querySelector('[data-recover]')?.addEventListener('click', (e) => { e.preventDefault(); history.pushState(null, '', '/console/recuperar'); renderRecover(); });
    const f = document.getElementById('f-forgot');
    if (!f) return;
    setTimeout(() => f.email.focus(), 30);
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = f.querySelector('button[type=submit]');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.value.trim())) return fieldError(f, 'email', 'Informe um e-mail válido.');
      busy(btn, true, 'Enviando…');
      try {
        await api('/console/forgot', { method: 'POST', body: { email: f.email.value }, auth: true });
        $app.innerHTML = authCard('Confira seu e-mail', `Se <b>${esc(f.email.value.trim())}</b> for de um superadmin, o link chega em alguns minutos e vale por 1 hora. Confira também o spam.`, `<a class="c-btn c-btn--block" href="/console/entrar">Voltar para a entrada</a>`);
      } catch (e) { busy(btn, false); fieldError(f, 'email', e.message); }
    });
  }

  async function renderReset(token) {
    let info;
    try { info = await api('/console/reset/' + encodeURIComponent(token), { auth: true }); }
    catch (e) { $app.innerHTML = authCard('Link indisponível', esc(e.message), `<a class="c-btn c-btn--block" href="/console/entrar">Ir para a entrada</a>`); return; }
    const min = info.passwordMin || 12;
    $app.innerHTML = authCard('Nova senha', `Crie a nova senha do console para ${esc(info.email)}. Na entrada, o código do app continua sendo pedido.`, `
      <form id="f-reset" novalidate>
        <div class="c-field"><label class="c-label" for="r-pass">Nova senha</label><input class="c-input" id="r-pass" name="password" type="password" autocomplete="new-password" placeholder="Mínimo de ${min} caracteres"></div>
        <div class="c-field"><label class="c-label" for="r-pass2">Repita a senha</label><input class="c-input" id="r-pass2" name="password2" type="password" autocomplete="new-password"></div>
        <div class="c-error" role="alert"></div>
        <button class="c-btn c-btn--primary c-btn--block" type="submit">Salvar nova senha</button>
      </form>`);
    const f = document.getElementById('f-reset');
    setTimeout(() => f.password.focus(), 30);
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = f.querySelector('button[type=submit]');
      if (f.password.value.length < min) return fieldError(f, 'password', `A senha precisa ter pelo menos ${min} caracteres.`);
      if (f.password.value !== f.password2.value) return fieldError(f, 'password2', 'As senhas não conferem.');
      busy(btn, true, 'Salvando…');
      try {
        await api('/console/reset/' + encodeURIComponent(token), { method: 'POST', body: { password: f.password.value }, auth: true });
        history.replaceState(null, '', '/console/entrar');
        renderLogin();
        toast('Senha redefinida. Entre com a nova senha.');
      } catch (e) { busy(btn, false); fieldError(f, e.data && e.data.field, e.message); }
    });
  }

  function renderRecover() {
    const on = state.status && state.status.recoveryEnabled;
    $app.innerHTML = authCard('Recuperar pelo servidor', 'Último recurso, para quando ninguém consegue entrar: redefine a senha e o app autenticador de um superadmin.', on ? `
      <form id="f-recover" novalidate>
        <div class="c-field"><label class="c-label" for="rv-token">Código de recuperação do servidor</label><input class="c-input mono" id="rv-token" name="token" autocomplete="off" spellcheck="false"><span class="c-hint">O valor de CONSOLE_RECOVERY_TOKEN. Cada valor funciona uma vez.</span></div>
        <div class="c-field"><label class="c-label" for="rv-email">E-mail do superadmin</label><input class="c-input" id="rv-email" name="email" type="email" autocomplete="username"></div>
        <div class="c-error" role="alert"></div>
        <button class="c-btn c-btn--primary c-btn--block" type="submit">Gerar link de acesso</button>
      </form>
      <p class="c-auth-foot"><a href="/console/entrar" data-back>Voltar</a></p>` : `
      <ol class="c-steps">
        <li><span>No servidor, defina a variável <code class="mono">CONSOLE_RECOVERY_TOKEN</code> com um código longo e aleatório (16 caracteres ou mais).</span></li>
        <li><span>Reinicie o servidor e volte a esta tela.</span></li>
        <li><span>Informe o código e o e-mail: sai um link para criar senha nova e cadastrar o app de novo.</span></li>
        <li><span>Depois, apague a variável. Cada valor só funciona uma vez.</span></li>
      </ol>
      <p class="c-auth-foot"><a href="/console/entrar" data-back>Voltar</a></p>`);
    $app.querySelector('[data-back]').addEventListener('click', (e) => { e.preventDefault(); history.replaceState(null, '', '/console/entrar'); renderLogin(); });
    const f = document.getElementById('f-recover');
    if (!f) return;
    setTimeout(() => f.token.focus(), 30);
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = f.querySelector('button[type=submit]');
      busy(btn, true, 'Verificando…');
      try {
        const r = await api('/console/recover', { method: 'POST', body: { token: f.token.value.trim(), email: f.email.value }, auth: true });
        $app.innerHTML = authCard('Acesso liberado', `Abra o link abaixo para ${esc(String(r.name).split(' ')[0])} criar a senha nova e cadastrar o app. Ele vale por 48 horas. Depois, apague <code class="mono">CONSOLE_RECOVERY_TOKEN</code> do servidor.`, `
          <div class="c-linkbox">${esc(r.link)}</div>
          <a class="c-btn c-btn--primary c-btn--block" style="margin-top:14px" href="${esc(r.link)}">Abrir agora</a>`);
      } catch (e) { busy(btn, false); fieldError(f, e.data && e.data.field, e.message); }
    });
  }
  function renderEnroll(p) {
    $app.innerHTML = authCard('Proteja seu acesso', 'O console pede um código do celular em toda entrada. Cadastre agora o app autenticador.', `
      <ol class="c-steps">
        <li><span>Abra um app autenticador (Google Authenticator, Authy, 1Password…).</span></li>
        <li><span>Escaneie o QR code abaixo, ou digite a chave.</span></li>
        <li><span>Confirme com o código que o app mostrar.</span></li>
      </ol>
      <div class="c-qr" aria-label="QR code para o app autenticador">${p.qr}</div>
      <div class="c-secret"><code>${esc(p.secret)}</code><button class="c-btn c-btn--sm" type="button" id="copy-secret">${icon('copy')}Copiar</button></div>
      ${codeForm('f-enroll', 'Código que apareceu no app')}`);
    document.getElementById('copy-secret').addEventListener('click', () => copy(p.secret.replace(/\s/g, ''), 'Chave'));
    paint();
    bindCode('f-enroll', p.ticket);
  }

  async function renderActivate(token) {
    let info;
    try { info = await api('/console/activate/' + encodeURIComponent(token), { auth: true }); }
    catch (e) {
      $app.innerHTML = authCard('Link indisponível', esc(e.message), `<a class="c-btn c-btn--block" href="/console/entrar">Ir para a entrada</a>`);
      return;
    }
    const min = info.passwordMin || 12;
    $app.innerHTML = authCard(`Olá, ${esc(String(info.name).split(' ')[0])}`, `Crie a senha do seu acesso ao console (${esc(info.email)}).`, `
      <form id="f-act" novalidate>
        <div class="c-field"><label class="c-label" for="a-pass">Senha</label><input class="c-input" id="a-pass" name="password" type="password" autocomplete="new-password" placeholder="Mínimo de ${min} caracteres"></div>
        <div class="c-field"><label class="c-label" for="a-pass2">Repita a senha</label><input class="c-input" id="a-pass2" name="password2" type="password" autocomplete="new-password"></div>
        <div class="c-error" role="alert"></div>
        <button class="c-btn c-btn--primary c-btn--block" type="submit">Continuar</button>
      </form>`);
    const f = document.getElementById('f-act');
    setTimeout(() => f.password.focus(), 30);
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = f.querySelector('button[type=submit]');
      if (f.password.value.length < min) return fieldError(f, 'password', `A senha precisa ter pelo menos ${min} caracteres.`);
      if (f.password.value !== f.password2.value) return fieldError(f, 'password2', 'As senhas não conferem.');
      busy(btn, true, 'Salvando…');
      try {
        const r = await api('/console/activate/' + encodeURIComponent(token), { method: 'POST', body: { password: f.password.value }, auth: true });
        history.replaceState(null, '', '/console/entrar');
        renderEnroll(r);
      } catch (e) { busy(btn, false); fieldError(f, e.data && e.data.field, e.message); }
    });
  }

  /* ═════════════ Estrutura ═════════════ */
  const NAV = [
    { key: 'overview', href: '/console', label: 'Visão geral', icon: 'layout-dashboard' },
    { key: 'orgs', href: '/console/organizacoes', label: 'Organizações', icon: 'building-2' },
    { key: 'waitlist', href: '/console/lista-de-espera', label: 'Lista de espera', icon: 'inbox', count: () => state.counts && state.counts.new },
    { key: 'admins', href: '/console/administradores', label: 'Superadmins', icon: 'shield-check' },
    { key: 'audit', href: '/console/auditoria', label: 'Auditoria', icon: 'scroll-text' },
  ];
  function shell(active, content) {
    const theme = document.documentElement.getAttribute('data-theme');
    $app.innerHTML = `<div class="c-shell">
      <aside class="c-side" aria-label="Navegação do console">
        <div class="c-side-brand"><img src="/rework_logo.svg" alt=""><span class="c-brand-name">reWork</span><span class="c-brand-tag">Console</span></div>
        <nav class="c-nav">${NAV.map(n => {
          const c = n.count ? n.count() : 0;
          return `<a href="${n.href}" data-link class="${n.key === active ? 'is-active' : ''}"${n.key === active ? ' aria-current="page"' : ''}>${icon(n.icon)}${n.label}${c ? `<span class="c-nav-count">${c}</span>` : ''}</a>`;
        }).join('')}</nav>
        <div class="c-side-foot">
          <div class="c-me"><div class="c-me-name">${esc(state.me.name)}</div><div class="c-me-mail">${esc(state.me.email)}</div></div>
          <button class="c-icon-btn" id="c-theme" title="${theme === 'light' ? 'Tema escuro' : 'Tema claro'}" aria-label="Trocar tema">${icon(theme === 'light' ? 'moon' : 'sun')}</button>
          <button class="c-icon-btn" id="c-logout" title="Sair" aria-label="Sair">${icon('log-out')}</button>
        </div>
      </aside>
      <div class="c-body">
        <div class="c-mobilebar">
          <button class="c-icon-btn" id="c-menu" aria-label="Abrir menu">${icon('menu')}</button>
          <img src="/rework_logo.svg" alt=""><span class="c-brand-name">reWork</span><span class="c-brand-tag">Console</span>
        </div>
        ${state.me.twoFactorExempt ? `<div class="c-banner c-banner--warn c-shell-banner" role="status">${icon('shield-alert')}<div><b>Você está no acesso padrão do console</b> (admin/admin123, sem verificação em duas etapas). Crie o seu superadmin pessoal e depois desative este acesso em <a href="/console/administradores" data-link>Superadmins</a>.</div></div>` : ''}
        <main class="c-main" id="c-main">${content}</main>
      </div>
    </div>`;
    document.getElementById('c-theme').addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('rework-console-theme', next); } catch (_) {}
      route();
    });
    document.getElementById('c-logout').addEventListener('click', async () => {
      try { await api('/console/logout', { method: 'POST', auth: true }); } catch (_) {}
      state.me = null; state.status = null;
      go('/console/entrar', true);
    });
    document.getElementById('c-menu').addEventListener('click', () => document.querySelector('.c-shell').classList.toggle('is-menu-open'));
    document.querySelector('.c-shell').addEventListener('click', (e) => {
      const sh = e.currentTarget;
      if (sh.classList.contains('is-menu-open') && !e.target.closest('.c-side') && !e.target.closest('#c-menu')) sh.classList.remove('is-menu-open');
    });
    paint();
    return document.getElementById('c-main');
  }
  function pageHead(title, sub, actions, crumb) {
    return `<div class="c-page-head"><div>
      ${crumb ? `<a class="c-crumb" href="${crumb.href}" data-link>${icon('arrow-left')}${esc(crumb.label)}</a>` : ''}
      <h1 class="c-page-title">${title}</h1>${sub ? `<p class="c-page-sub">${sub}</p>` : ''}</div>
      ${actions ? `<div class="c-actions">${actions}</div>` : ''}</div>`;
  }
  const skel = (h, w) => `<div class="c-skel" style="height:${h}px;${w ? `width:${w}` : ''}"></div>`;
  function kpi(label, iconName, value, foot) {
    return `<div class="c-kpi"><div class="c-kpi-label">${icon(iconName)}${label}</div><div class="c-kpi-value">${value}</div>${foot ? `<div class="c-kpi-foot">${foot}</div>` : ''}</div>`;
  }
  function errorBlock(main, e, retry) {
    main.innerHTML += `<div class="c-card"><div class="c-empty">${icon('triangle-alert')}<div>${esc(e.message)}</div><button class="c-btn c-btn--sm" style="margin-top:12px" id="c-retry">Tentar de novo</button></div></div>`;
    paint();
    document.getElementById('c-retry').addEventListener('click', retry);
  }

  /* ── Gráfico de barras (uma série; hover com tooltip; tabela pra leitor de tela) ── */
  function barChart(host, data, opts) {
    const draw = () => {
      if (!host.isConnected) return;
      const W = Math.max(280, host.clientWidth), H = opts.height || 180;
      const padL = 32, padR = 4, padT = 10, padB = 24;
      const n = data.length;
      const rawMax = Math.max(0, ...data.map(d => d.value));
      const step = rawMax <= 4 ? 1 : Math.ceil(rawMax / 4 / (rawMax > 40 ? 10 : rawMax > 20 ? 5 : 1)) * (rawMax > 40 ? 10 : rawMax > 20 ? 5 : 1);
      const max = Math.max(step * 4, rawMax <= 4 ? 4 : 0) || 4;
      const plotW = W - padL - padR, plotH = H - padT - padB;
      const col = plotW / n;
      const gap = 2;
      const bw = Math.max(2, col - gap);
      const y = (v) => padT + plotH - (v / max) * plotH;
      let svg = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="${esc(opts.title)}">`;
      for (let t = 0; t <= max; t += step) {
        const yy = Math.round(y(t)) + .5;
        svg += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}"/><text class="axis" x="${padL - 8}" y="${yy + 4}" text-anchor="end">${num(t)}</text>`;
      }
      const every = n <= 12 ? 1 : Math.max(1, Math.ceil(n / (W < 480 ? 4 : 7)));
      data.forEach((d, i) => {
        const x = padL + i * col + gap / 2;
        const h = (d.value / max) * plotH;
        const top = padT + plotH - h;
        if (h > 0) {
          const r = Math.min(4, bw / 2, h);
          svg += `<path class="bar" data-i="${i}" d="M${x},${padT + plotH} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${padT + plotH} Z"/>`;
        }
        if (i % every === 0 || i === n - 1) svg += `<text class="axis" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(d.short)}</text>`;
        svg += `<rect class="hit" data-i="${i}" x="${padL + i * col}" y="${padT}" width="${col}" height="${plotH}"/>`;
      });
      svg += '</svg>';
      host.innerHTML = `<div class="c-chart">${svg}<div class="c-tip" hidden></div></div>
        <table class="sr-only"><caption>${esc(opts.title)}</caption><tr><th>Período</th><th>${esc(opts.valueName)}</th></tr>${data.map(d => `<tr><td>${esc(d.label)}</td><td>${esc(opts.format(d.value))}</td></tr>`).join('')}</table>`;
      const wrap = host.querySelector('.c-chart');
      const tip = wrap.querySelector('.c-tip');
      wrap.addEventListener('mousemove', (ev) => {
        const hit = ev.target.closest('.hit');
        wrap.querySelectorAll('.bar.is-on').forEach(b => b.classList.remove('is-on'));
        if (!hit) { tip.hidden = true; wrap.classList.remove('is-hovering'); return; }
        const i = Number(hit.dataset.i);
        const d = data[i];
        wrap.classList.add('is-hovering');
        wrap.querySelector(`.bar[data-i="${i}"]`)?.classList.add('is-on');
        tip.innerHTML = `<b>${esc(opts.format(d.value))}</b><span>${esc(d.label)}</span>`;
        tip.hidden = false;
        const scale = wrap.clientWidth / W;
        tip.style.left = `${(padL + i * col + col / 2) * scale}px`;
        tip.style.top = `${Math.min(y(d.value), padT + plotH - 2) * scale}px`;
      });
      wrap.addEventListener('mouseleave', () => { tip.hidden = true; wrap.classList.remove('is-hovering'); wrap.querySelectorAll('.bar.is-on').forEach(b => b.classList.remove('is-on')); });
    };
    draw();
    state.charts.push(draw);
  }
  let _rt;
  window.addEventListener('resize', () => { clearTimeout(_rt); _rt = setTimeout(() => state.charts.forEach(fn => fn()), 120); });
  function dailyData(series) {
    return series.map(s => {
      const [yy, mm, dd] = s.date.split('-').map(Number);
      return { value: s.value, short: `${dd}/${String(mm).padStart(2, '0')}`, label: `${dd} ${MONTHS[mm - 1]} ${yy}` };
    });
  }

  /* ═════════════ Visão geral ═════════════ */
  const STATUS = {
    new: { label: 'Novo', cls: 'c-pill--accent' },
    reviewing: { label: 'Em análise', cls: 'c-pill--info' },
    approved: { label: 'Aprovado', cls: 'c-pill--good' },
    rejected: { label: 'Recusado', cls: '' }
  };
  const TEAM = { '1-5': '1 a 5 pessoas', '6-15': '6 a 15 pessoas', '16-50': '16 a 50 pessoas', '51-200': '51 a 200 pessoas', '200+': 'Mais de 200' };
  const SOURCE = { indicacao: 'Indicação', google: 'Google', instagram: 'Instagram', linkedin: 'LinkedIn', evento: 'Evento', outro: 'Outro' };
  const statusPill = (s) => `<span class="c-pill ${(STATUS[s] || {}).cls || ''}">${esc((STATUS[s] || { label: s }).label)}</span>`;
  const INTEGRATIONS = { smtp: 'E-mail (SMTP)', discordBot: 'Bot do Discord', discordLogin: 'Login com Discord', googleLogin: 'Login com Google', google: 'Google Agenda' };

  async function pageOverview() {
    const main = shell('overview', pageHead('Visão geral', 'Tudo o que acontece na plataforma, em um lugar.') +
      `<div class="c-kpis">${[1, 2, 3, 4, 5].map(() => `<div class="c-kpi">${skel(12, '60%')}<div style="height:10px"></div>${skel(26, '40%')}</div>`).join('')}</div>
       <div class="c-grid-2"><div class="c-card"><div class="c-card-body">${skel(200)}</div></div><div class="c-card"><div class="c-card-body">${skel(200)}</div></div></div>`);
    let d;
    try { d = await api('/console/overview'); }
    catch (e) { if (e.silent) return; main.innerHTML = pageHead('Visão geral'); return errorBlock(main, e, pageOverview); }
    state.counts = d.waitlist.counts;
    const o = d.totals, s = d.system;
    const nav = document.querySelector('.c-nav a[href="/console/lista-de-espera"]');
    if (nav && state.counts.new && !nav.querySelector('.c-nav-count')) nav.insertAdjacentHTML('beforeend', `<span class="c-nav-count">${state.counts.new}</span>`);
    main.innerHTML = pageHead('Visão geral', 'Tudo o que acontece na plataforma, em um lugar.') + `
      <div class="c-kpis">
        ${kpi('Organizações', 'building-2', num(d.orgs.total), `${num(d.orgs.items.filter(x => x.owner).length)} com dono ativo`)}
        ${kpi('Pessoas ativas', 'users', num(o.active30), `de ${num(o.people)} · ${num(o.active7)} nos últimos 7 dias`)}
        ${kpi('Demandas abertas', 'kanban-square', num(o.demandsOpen), `30 dias: ${num(o.created30)} novas, ${num(o.completed30)} concluídas`)}
        ${kpi('Horas apontadas', 'clock', hrs(o.hours30), 'Últimos 30 dias')}
        ${kpi('Lista de espera', 'inbox', num(d.waitlist.counts.new), `${num(d.waitlist.counts.new)} ${d.waitlist.counts.new === 1 ? 'novo' : 'novos'} · ${num(d.waitlist.counts.reviewing)} em análise`)}
      </div>
      <div class="c-grid-2">
        <div class="c-stack">
          <section class="c-card">
            <div class="c-card-head"><div><div class="c-card-title">Demandas criadas por dia</div><div class="c-card-sub">Últimos 30 dias, todas as organizações</div></div></div>
            <div class="c-card-body"><div id="ch-created"></div></div>
          </section>
          <section class="c-card">
            <div class="c-card-head"><div class="c-card-title">Organizações</div><a class="c-btn c-btn--sm c-btn--ghost" href="/console/organizacoes" data-link>Ver todas${icon('arrow-right')}</a></div>
            ${orgTable(d.orgs.items, true)}
          </section>
        </div>
        <div class="c-stack">
          <section class="c-card">
            <div class="c-card-head"><div class="c-card-title">Pedidos recentes</div><a class="c-btn c-btn--sm c-btn--ghost" href="/console/lista-de-espera" data-link>Abrir lista${icon('arrow-right')}</a></div>
            ${d.waitlist.latest.length ? d.waitlist.latest.map(r => `
              <a class="c-wl-item" href="/console/lista-de-espera?id=${esc(r.id)}" data-link style="text-decoration:none;color:inherit">
                <span class="c-avatar">${esc(initials(r.name))}</span>
                <span class="c-wl-main"><span class="c-wl-top"><span class="c-wl-name">${esc(r.company)}</span>${statusPill(r.status)}</span>
                <span class="c-wl-meta" style="display:block">${esc(r.name)} · ${esc(TEAM[r.teamSize] || r.teamSize)} · ${rel(r.createdAt)}</span></span>
              </a>`).join('') : `<div class="c-empty">${icon('inbox')}<div>Nenhum pedido ainda. O formulário público fica em <a href="/acesso" target="_blank" rel="noopener">/acesso</a>.</div></div>`}
          </section>
          <section class="c-card">
            <div class="c-card-head"><div class="c-card-title">Sistema</div><span class="c-pill c-pill--good">${icon('circle-check')}No ar</span></div>
            <div class="c-card-body">
              <dl class="c-dl">
                <dt>Versão</dt><dd class="mono">${esc(String(s.build).slice(0, 7))}</dd>
                <dt>No ar há</dt><dd>${duration(s.uptimeSec)}</dd>
                <dt>Memória</dt><dd>${num(s.memoryMb)} MB</dd>
                <dt>Banco de dados</dt><dd>${bytes(s.dbBytes)}</dd>
                <dt>Arquivos enviados</dt><dd>${bytes(s.uploadsBytes)} · ${num(s.uploadsFiles || 0)}</dd>
                <dt>Sessões ativas no reWork</dt><dd>${num(s.sessions)}</dd>
                <dt>Node</dt><dd class="mono">${esc(s.node)}</dd>
              </dl>
              <div class="c-integrations">${Object.entries(INTEGRATIONS).map(([k, label]) => s.integrations[k]
                ? `<span class="c-pill c-pill--good">${icon('check')}${label}</span>`
                : `<span class="c-pill">${icon('minus')}${label}: desligado</span>`).join('')}</div>
            </div>
          </section>
        </div>
      </div>`;
    paint();
    barChart(document.getElementById('ch-created'), dailyData(d.series.created), { title: 'Demandas criadas por dia, últimos 30 dias', valueName: 'Demandas', format: v => `${num(v)} ${v === 1 ? 'demanda' : 'demandas'}` });
  }

  /* ── Planos e limites ── */
  // Teste: mostra o prazo (ou que ainda não começou) no próprio selo.
  function planPill(p) {
    if (p.trial) {
      if (p.readOnly) return `<span class="c-pill c-pill--bad">${icon('lock')}Teste vencido</span>`;
      if (!p.trialEndsAt) return `<span class="c-pill c-pill--warn">Teste · aguardando o dono</span>`;
      return `<span class="c-pill c-pill--warn">Teste · ${p.trialDaysLeft === 1 ? '1 dia' : `${num(p.trialDaysLeft)} dias`}</span>`;
    }
    return `<span class="c-pill ${p.id === 'custom' ? 'c-pill--info' : 'c-pill--accent'}">${esc(p.name)}</span>`;
  }
  const gb = (n) => `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 }).format(n)} GB`;
  const planLimits = (p) => [
    p.users == null ? 'pessoas sem limite' : `até ${num(p.users)} pessoas`,
    p.storageGb == null ? 'armazenamento sem limite' : gb(p.storageGb),
    p.fileMb == null ? 'arquivos no teto do servidor' : `arquivos até ${num(p.fileMb)} MB`
  ].join(' · ');
  const trialLine = (p) => !p.trial ? '' : p.readOnly
    ? `Teste venceu em ${dateTime(p.trialEndsAt).split(',')[0]}: a organização está só para consulta até você escolher um plano.`
    : p.trialEndsAt ? `Teste até ${dateTime(p.trialEndsAt).split(',')[0]} (${p.trialDaysLeft === 1 ? 'falta 1 dia' : `faltam ${num(p.trialDaysLeft)} dias`}). Depois fica só para consulta.`
    : 'O teste de 14 dias começa quando o dono aceitar o convite.';
  // Pessoas: mostra "usados / limite" quando há limite.
  const seatsCell = (o) => o.usage && o.usage.plan.users != null
    ? `${num(o.usage.seats.used)}<span class="c-of"> / ${num(o.usage.plan.users)}</span>` : num(o.members);
  function usageMeter(label, used, limit, fmt, foot) {
    const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
    const tone = !limit ? '' : used >= limit ? ' is-full' : pct >= 85 ? ' is-high' : '';
    return `<div class="c-usage${tone}">
      <div class="c-usage-top"><span class="c-usage-label">${label}</span><span class="c-usage-num"><b>${fmt(used)}</b>${limit != null ? ` de ${fmt(limit)}` : ' · sem limite'}</span></div>
      <div class="c-usage-bar" role="progressbar" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}"><span style="width:${limit ? Math.max(pct, used > 0 ? 1.5 : 0) : 0}%"></span></div>
      ${foot ? `<div class="c-usage-foot">${foot}</div>` : ''}
    </div>`;
  }
  const TEAM_PLAN = { '1-5': 'essencial', '6-15': 'equipe', '16-50': 'agencia', '51-200': 'custom', '200+': 'custom' };

  /* compact: versão enxuta pra coluna da visão geral. */
  function orgTable(items, compact) {
    if (!items.length) return `<div class="c-empty">${icon('building-2')}<div>Nenhuma organização.</div></div>`;
    const cols = compact
      ? [['Pessoas', o => num(o.members)], ['Abertas', o => num(o.demandsOpen)], ['Horas 30d', o => hrs(o.hours30)]]
      : [['Pessoas', seatsCell], ['Ativas 30d', o => num(o.active30)], ['Arquivos', o => bytes(o.usage ? o.usage.storage.bytes : 0)], ['Abertas', o => num(o.demandsOpen)], ['Horas 30d', o => hrs(o.hours30)]];
    return `<div class="c-table-wrap"><table class="c-table">
      <thead><tr><th>Organização</th>${compact ? '' : '<th>Plano</th>'}${cols.map(([h]) => `<th class="num">${h}</th>`).join('')}<th>Última atividade</th></tr></thead>
      <tbody>${items.map(o => `<tr class="is-link" data-href="/console/organizacoes/${esc(o.id)}">
        <td><div class="c-cell-main">${esc(o.name)}</div><div class="c-cell-sub">${o.owner ? esc(o.owner.name) : (o.ownerInvite ? '<span class="c-pill c-pill--warn">Aguardando o dono</span>' : 'Sem dono')} · desde ${o.createdAt ? dateTime(o.createdAt).split(',')[0] : '—'}</div></td>
        ${compact ? '' : `<td>${o.usage ? planPill(o.usage.plan) : '—'}</td>`}
        ${cols.map(([, fn]) => `<td class="num">${fn(o)}</td>`).join('')}<td style="white-space:nowrap">${rel(o.lastActivityAt)}</td></tr>`).join('')}</tbody>
    </table></div>`;
  }
  function deletedTable(items) {
    return `<div class="c-table-wrap"><table class="c-table">
      <thead><tr><th>Organização</th><th>Excluída</th><th class="num">Pessoas</th><th>Apagada de vez em</th></tr></thead>
      <tbody>${items.map(x => `<tr class="is-link" data-href="/console/organizacoes/${esc(x.id)}">
        <td><div class="c-cell-main">${esc(x.name)}</div><div class="c-cell-sub">${x.owner ? esc(x.owner.name) : 'Sem dono'}</div></td>
        <td style="white-space:nowrap">${rel(x.deletedAt)}${x.deletedBy ? `<div class="c-cell-sub">por ${esc(x.deletedBy)}</div>` : ''}</td>
        <td class="num">${num(x.members)}</td>
        <td style="white-space:nowrap"><span class="c-pill ${x.daysLeft <= 3 ? 'c-pill--bad' : 'c-pill--warn'}">${x.daysLeft === 0 ? 'hoje' : x.daysLeft === 1 ? '1 dia' : `${x.daysLeft} dias`}</span><div class="c-cell-sub">${dateTime(x.purgeAt).split(',')[0]}</div></td></tr>`).join('')}</tbody>
    </table></div>`;
  }
  document.addEventListener('click', (ev) => {
    const tr = ev.target.closest('tr[data-href]');
    if (tr && !ev.target.closest('a,button')) go(tr.dataset.href);
  });

  /* ═════════════ Organizações ═════════════ */
  async function pageOrgs() {
    const main = shell('orgs', pageHead('Organizações', 'Quem usa o reWork e como está usando.') + `<div class="c-card"><div class="c-card-body">${skel(120)}</div></div>`);
    let d;
    try { d = await api('/console/orgs'); }
    catch (e) { if (e.silent) return; main.innerHTML = pageHead('Organizações'); return errorBlock(main, e, pageOrgs); }
    state.plans = d.plans;
    main.innerHTML = pageHead('Organizações', 'Quem usa o reWork e como está usando. Organizações novas nascem da lista de espera.') + `<section class="c-card">${orgTable(d.items)}</section>
      ${(d.deleted || []).length ? `<section class="c-card" style="margin-top:16px">
        <div class="c-card-head"><div><div class="c-card-title">Excluídas</div><div class="c-card-sub">Ninguém acessa. Os dados ficam guardados por 30 dias e dá para restaurar; depois disso somem de vez.</div></div></div>
        ${deletedTable(d.deleted)}</section>` : ''}`;
    paint();
  }

  const ACCESS = { owner: ['Dono', 'c-pill--accent'], admin: ['Admin', 'c-pill--accent'], mod: ['Moderador', 'c-pill--info'], equipe: ['Equipe', ''], free: ['Freelancer', 'c-pill--warn'] };
  async function pageOrg(id) {
    const main = shell('orgs', pageHead('Organização', '', '', { href: '/console/organizacoes', label: 'Organizações' }) + `<div class="c-kpis">${[1, 2, 3, 4, 5].map(() => `<div class="c-kpi">${skel(40)}</div>`).join('')}</div>`);
    let d;
    try { d = await api('/console/orgs/' + encodeURIComponent(id)); }
    catch (e) { if (e.silent) return; main.innerHTML = pageHead('Organização', '', '', { href: '/console/organizacoes', label: 'Organizações' }); return errorBlock(main, e, () => pageOrg(id)); }
    state.plans = d.plans;
    if (d.deleted) return renderDeletedOrg(main, id, d.deleted);
    const o = d.org;
    const months = d.hoursByMonth.map(m => { const [yy, mm] = m.key.split('-').map(Number); return { value: m.value, short: MONTHS[mm - 1], label: `${MONTHS[mm - 1]} ${yy}` }; });
    const ownerLine = o.owner
      ? `Dono: <b>${esc(o.owner.name)}</b>${o.owner.email ? ` (${esc(o.owner.email)})` : ''}`
      : o.ownerInvite ? `Aguardando ${esc(o.ownerInvite.email)} aceitar o convite de dono${o.ownerInvite.expired ? ' (convite vencido)' : ''}` : 'Sem dono';
    const ownerBtn = d.members.some(m => m.active) ? `<button class="c-btn c-btn--sm" id="org-owner-btn">${icon('crown')}Trocar dono</button>` : '';
    main.innerHTML = pageHead(esc(o.name), `${ownerLine} · desde ${o.createdAt ? dateTime(o.createdAt).split(',')[0] : '—'} · última atividade ${rel(o.lastActivityAt)}`, ownerBtn, { href: '/console/organizacoes', label: 'Organizações' }) + `
      <div class="c-kpis">
        ${kpi('Pessoas', 'users', num(o.members), `${num(o.admins)} admins · ${num(o.freelancers)} freelancers · ${num(o.deactivated)} desativadas`)}
        ${kpi('Ativas em 30 dias', 'activity', num(o.active30), `${num(o.active7)} nos últimos 7 dias`)}
        ${kpi('Squads e clientes', 'layers', `${num(o.squads)} · ${num(o.clients)}`, `${num(o.projects)} projetos`)}
        ${kpi('Demandas', 'kanban-square', num(o.demandsTotal), `${num(o.demandsOpen)} abertas agora`)}
        ${kpi('Horas apontadas', 'clock', hrs(o.hoursTotal), `${hrs(o.hours30)} nos últimos 30 dias`)}
      </div>
      ${planCard(o)}
      <div class="c-grid-2" style="margin-bottom:16px">
        <section class="c-card"><div class="c-card-head"><div><div class="c-card-title">Demandas criadas por dia</div><div class="c-card-sub">Últimos 30 dias</div></div></div><div class="c-card-body"><div id="ch-org-created"></div></div></section>
        <section class="c-card"><div class="c-card-head"><div><div class="c-card-title">Horas apontadas por mês</div><div class="c-card-sub">Últimos 6 meses</div></div></div><div class="c-card-body"><div id="ch-org-hours"></div></div></section>
      </div>
      <section class="c-card" style="margin-bottom:16px">
        <div class="c-card-head"><div class="c-card-title">Squads</div><span class="c-card-sub">${num(d.squads.length)} squads</span></div>
        <div class="c-table-wrap"><table class="c-table"><thead><tr><th>Squad</th><th class="num">Pessoas</th><th class="num">Clientes</th><th class="num">Abertas</th><th class="num">Total de demandas</th></tr></thead>
        <tbody>${d.squads.map(s => `<tr><td><span class="c-dot" style="background:${esc(s.color)};margin-right:8px"></span>${esc(s.name)}</td><td class="num">${num(s.members)}</td><td class="num">${num(s.clients)}</td><td class="num">${num(s.open)}</td><td class="num">${num(s.total)}</td></tr>`).join('')}</tbody></table></div>
      </section>
      <section class="c-card">
        <div class="c-card-head"><div class="c-card-title">Pessoas</div><input class="c-input" id="m-search" placeholder="Buscar por nome ou e-mail" style="max-width:260px;height:32px" aria-label="Buscar pessoas"></div>
        <div class="c-table-wrap"><table class="c-table"><thead><tr><th>Nome</th><th>Área · cargo</th><th>Acesso</th><th>Squads</th><th>Último acesso</th><th>Situação</th></tr></thead><tbody id="m-body"></tbody></table></div>
      </section>
      <section class="c-card c-danger" style="margin-top:16px">
        <div class="c-card-head"><div class="c-card-title">Dados e exclusão</div></div>
        <div class="c-danger-row">
          <div><div class="c-danger-title">Baixar backup</div><div class="c-hint">Arquivo JSON com squads, clientes, projetos, fluxos, demandas, documentos e a lista de pessoas. O cofre de senhas não entra.</div></div>
          <a class="c-btn c-btn--sm" href="/api/console/orgs/${esc(o.id)}/export" download>${icon('download')}Baixar backup</a>
        </div>
        <div class="c-danger-row">
          <div><div class="c-danger-title">Excluir organização</div><div class="c-hint">${o.isDefault ? 'É a organização principal desta instalação: não pode ser excluída.' : 'Ninguém mais entra, na hora. Os dados ficam guardados por 30 dias (dá para restaurar aqui) e depois são apagados de vez.'}</div></div>
          <button class="c-btn c-btn--sm c-btn--danger" id="org-del-btn" ${o.isDefault ? 'disabled' : ''}>${icon('trash-2')}Excluir…</button>
        </div>
      </section>`;
    const body = document.getElementById('m-body');
    const renderMembers = (q) => {
      const t = String(q || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      const list = d.members.filter(m => !t || `${m.name} ${m.email || ''} ${m.username}`.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(t));
      body.innerHTML = list.length ? list.map(m => {
        const [al, ac] = ACCESS[m.access] || ACCESS.equipe;
        return `<tr style="${m.active ? '' : 'opacity:.55'}"><td><div class="c-cell-main">${esc(m.name)}</div><div class="c-cell-sub">${esc(m.email || '@' + m.username)}</div></td>
          <td>${esc([m.role, m.position].filter(Boolean).join(' · ') || '—')}</td>
          <td><span class="c-pill ${ac}">${al}</span></td>
          <td class="c-cell-sub">${m.access === 'admin' ? 'Todos' : esc(m.squads.join(', ') || '—')}</td>
          <td>${rel(m.lastSeenAt)}</td>
          <td>${m.active ? '<span class="c-pill c-pill--good">Ativa</span>' : '<span class="c-pill">Desativada</span>'}</td></tr>`;
      }).join('') : `<tr><td colspan="6"><div class="c-empty">Ninguém encontrado.</div></td></tr>`;
    };
    renderMembers('');
    document.getElementById('m-search').addEventListener('input', (e) => renderMembers(e.target.value));
    document.getElementById('org-owner-btn')?.addEventListener('click', () => {
      const cands = d.members.filter(m => m.active && m.access !== 'owner');
      const m = modal('Trocar o dono', `<form id="f-owner" novalidate>
          <p style="font-size:13.5px;color:var(--text-dim);margin-bottom:14px">Use quando o dono saiu da empresa ou perdeu o acesso. O dono atual vira administrador.</p>
          <div class="c-field"><label class="c-label" for="ow-user">Novo dono</label>
            <select class="c-select" id="ow-user" name="userId"><option value="">Escolha…</option>${cands.map(x => `<option value="${esc(x.id)}">${esc(x.name)}${x.email ? ` · ${esc(x.email)}` : ''}</option>`).join('')}</select></div>
          <div class="c-error" role="alert"></div></form>`,
        `<button class="c-btn" data-close>Cancelar</button><button class="c-btn c-btn--primary" id="ow-go">Trocar dono</button>`);
      m.el.querySelector('#ow-go').addEventListener('click', async (ev) => {
        const f = m.el.querySelector('#f-owner');
        if (!f.userId.value) return fieldError(f, 'userId', 'Escolha uma pessoa.');
        busy(ev.currentTarget, true, 'Trocando…');
        try { await api(`/console/orgs/${encodeURIComponent(id)}/owner`, { method: 'POST', body: { userId: f.userId.value } }); m.close(); toast('Dono trocado.'); pageOrg(id); }
        catch (e) { busy(ev.currentTarget, false); fieldError(f, 'userId', e.message); }
      });
    });
    document.getElementById('org-plan-btn').addEventListener('click', () => planModal(o, () => pageOrg(id)));
    document.getElementById('org-del-btn')?.addEventListener('click', () => deleteOrgModal(o, id));
    paint();
    barChart(document.getElementById('ch-org-created'), dailyData(d.series.created), { title: 'Demandas criadas por dia', valueName: 'Demandas', format: v => `${num(v)} ${v === 1 ? 'demanda' : 'demandas'}`, height: 170 });
    barChart(document.getElementById('ch-org-hours'), months, { title: 'Horas apontadas por mês', valueName: 'Horas', format: hrs, height: 170 });
  }

  function planCard(o) {
    const u = o.usage, p = u.plan;
    const seatsFoot = `${num(u.seats.members)} ${u.seats.members === 1 ? 'pessoa ativa' : 'pessoas ativas'}${u.seats.pending ? ` + ${num(u.seats.pending)} ${u.seats.pending === 1 ? 'convite pendente' : 'convites pendentes'}` : ''}`;
    return `<section class="c-card" style="margin-bottom:16px">
      <div class="c-card-head"><div><div class="c-card-title">Plano e limites</div><div class="c-card-sub">${planPill(p)}${p.trial ? `<span class="c-pill" style="margin-left:6px">${esc(p.name)}</span>` : ''}<span style="margin-left:8px">${esc(planLimits(p))}</span></div></div>
        <button class="c-btn c-btn--sm" id="org-plan-btn">${icon('sliders-horizontal')}Mudar plano</button></div>
      <div class="c-card-body">
        ${p.trial ? `<div class="c-banner ${p.readOnly ? 'c-banner--bad' : 'c-banner--warn'}" style="margin:0 0 14px">${icon(p.readOnly ? 'lock' : 'hourglass')}<div>${esc(trialLine(p))}</div></div>` : ''}
        <div class="c-usage-grid">
          ${usageMeter('Pessoas', u.seats.used, p.users, num, seatsFoot)}
          ${usageMeter('Armazenamento', u.storage.bytes, p.storageBytes, bytes, `${num(u.storage.files)} ${u.storage.files === 1 ? 'arquivo' : 'arquivos'} · atualiza a cada 10 min`)}
        </div>
        ${(p.users != null && u.seats.used >= p.users) || (p.storageBytes != null && u.storage.bytes >= p.storageBytes)
          ? `<div class="c-banner c-banner--warn" style="margin:14px 0 0">${icon('triangle-alert')}<div>Limite atingido: ${p.users != null && u.seats.used >= p.users ? 'novos convites e reativações ficam bloqueados' : ''}${p.users != null && u.seats.used >= p.users && p.storageBytes != null && u.storage.bytes >= p.storageBytes ? ' e ' : ''}${p.storageBytes != null && u.storage.bytes >= p.storageBytes ? 'novos arquivos são recusados' : ''}. Ninguém perde acesso nem dados.</div></div>` : ''}
      </div>
    </section>`;
  }
  function planModal(o, done) {
    const cur = o.usage.plan;
    const plans = state.plans || [];
    let sel = cur.id;
    const optHTML = (p) => `<label class="c-plan-opt">
        <input type="radio" name="planId" value="${esc(p.id)}"${p.id === sel ? ' checked' : ''}>
        <span class="c-plan-opt-main"><span class="c-plan-opt-name">${esc(p.name)}${p.id === cur.id ? '<span class="c-pill" style="margin-left:8px">Atual</span>' : ''}</span>
        <span class="c-plan-opt-sub">${p.id === 'custom' ? 'Você define os limites (caminho do Enterprise)' : esc(planLimits(p)) + (p.trial ? ' · 14 dias, depois só consulta' : '')}</span></span></label>`;
    const m = modal('Mudar plano', `<form id="f-plan" novalidate>
        <div class="c-plan-opts">${plans.map(optHTML).join('')}</div>
        <div id="plan-trial" class="c-plan-custom"${sel === 'teste' ? '' : ' hidden'}>
          <div class="c-field" style="grid-column:1/-1"><label class="c-label" for="pl-days">Dias de teste a partir de hoje</label><input class="c-input" id="pl-days" name="trialDays" type="number" min="0" max="90" step="1" inputmode="numeric" placeholder="${cur.trial && cur.trialEndsAt ? `Manter o prazo atual (${dateTime(cur.trialEndsAt).split(',')[0]})` : 'Padrão: 14 dias'}">
            <span class="c-hint">${cur.trial && cur.readOnly ? 'Informe os dias para reabrir o teste.' : 'Use para estender o teste de quem está avaliando. 0 encerra o teste agora.'}</span></div>
        </div>
        <div id="plan-custom" class="c-plan-custom c-plan-custom--3"${sel === 'custom' ? '' : ' hidden'}>
          <div class="c-field"><label class="c-label" for="pl-users">Pessoas</label><input class="c-input" id="pl-users" name="users" type="number" min="1" step="1" inputmode="numeric" placeholder="Sem limite" value="${cur.id === 'custom' && cur.users != null ? cur.users : ''}"></div>
          <div class="c-field"><label class="c-label" for="pl-storage">Armazenamento (GB)</label><input class="c-input" id="pl-storage" name="storageGb" type="number" min="1" step="0.5" inputmode="decimal" placeholder="Sem limite" value="${cur.id === 'custom' && cur.storageGb != null ? cur.storageGb : ''}"></div>
          <div class="c-field"><label class="c-label" for="pl-file">Por arquivo (MB)</label><input class="c-input" id="pl-file" name="fileMb" type="number" min="1" step="1" inputmode="numeric" placeholder="Teto do servidor" value="${cur.id === 'custom' && cur.fileMb != null ? cur.fileMb : ''}"></div>
          <p class="c-hint" style="grid-column:1/-1;margin-top:-6px">Em branco = sem limite (o arquivo segue o teto do servidor).</p>
        </div>
        <div id="plan-warn"></div>
        <div class="c-error" role="alert"></div></form>`,
      `<button class="c-btn" data-close>Cancelar</button><button class="c-btn c-btn--primary" id="pl-go">Salvar plano</button>`);
    m.el.querySelector('.c-modal').classList.add('c-modal--wide');
    const f = m.el.querySelector('#f-plan');
    const limitsNow = () => {
      if (sel !== 'custom') return plans.find(p => p.id === sel);
      const v = (x) => (x === '' ? null : Number(x));
      return { users: v(f.users.value), storageGb: v(f.storageGb.value) };
    };
    const warn = () => {
      const l = limitsNow() || {};
      const msgs = [];
      if (l.users != null && o.usage.seats.used > l.users) msgs.push(`a organização já ocupa ${num(o.usage.seats.used)} lugares (acima de ${num(l.users)})`);
      if (l.storageGb != null && o.usage.storage.bytes > l.storageGb * 1024 ** 3) msgs.push(`já usa ${bytes(o.usage.storage.bytes)} de arquivos (acima de ${gb(l.storageGb)})`);
      f.querySelector('#plan-warn').innerHTML = msgs.length
        ? `<div class="c-banner c-banner--warn" style="margin:4px 0 12px">${icon('triangle-alert')}<div>Abaixo do uso atual: ${msgs.join(' e ')}. Ninguém perde acesso nem arquivos, mas novos convites e envios ficam bloqueados até voltar ao limite.</div></div>` : '';
      paint();
    };
    f.addEventListener('change', (e) => {
      if (e.target.name === 'planId') { sel = e.target.value; f.querySelector('#plan-custom').hidden = sel !== 'custom'; f.querySelector('#plan-trial').hidden = sel !== 'teste'; }
      warn();
    });
    f.addEventListener('input', warn);
    warn();
    const go = async () => {
      const btn = m.el.querySelector('#pl-go');
      busy(btn, true, 'Salvando…');
      const body = { planId: sel };
      if (sel === 'custom') { body.users = f.users.value === '' ? null : Number(f.users.value); body.storageGb = f.storageGb.value === '' ? null : Number(f.storageGb.value); body.fileMb = f.fileMb.value === '' ? null : Number(f.fileMb.value); }
      if (sel === 'teste' && f.trialDays.value !== '') body.trialDays = Number(f.trialDays.value);
      try { await api(`/console/orgs/${encodeURIComponent(o.id)}/plan`, { method: 'PUT', body }); m.close(); toast('Plano atualizado.'); done(); }
      catch (e) { busy(btn, false); fieldError(f, e.data && e.data.field, e.message); }
    };
    m.el.querySelector('#pl-go').addEventListener('click', go);
    f.addEventListener('submit', (e) => { e.preventDefault(); go(); });
  }
  /* Confirmação digitando o nome (excluir / apagar de vez). */
  function confirmNameModal({ title, intro, name, button, withReason, run }) {
    const m = modal(title, `<form id="f-conf" novalidate>
        <div style="font-size:13.5px;color:var(--text-dim);margin-bottom:14px">${intro}</div>
        ${withReason ? `<div class="c-field"><label class="c-label" for="cf-reason">Motivo (opcional, fica na auditoria)</label><textarea class="c-textarea" id="cf-reason" name="reason" maxlength="500" rows="2" placeholder="Ex.: cliente cancelou, pediu para encerrar a conta"></textarea></div>` : ''}
        <div class="c-field"><label class="c-label" for="cf-name">Digite <b>${esc(name)}</b> para confirmar</label><input class="c-input" id="cf-name" name="confirm" autocomplete="off" spellcheck="false"></div>
        <div class="c-error" role="alert"></div></form>`,
      `<button class="c-btn" data-close>Cancelar</button><button class="c-btn c-btn--danger-solid" id="cf-go" disabled>${esc(button)}</button>`);
    const f = m.el.querySelector('#f-conf');
    const btn = m.el.querySelector('#cf-go');
    const same = () => f.confirm.value.trim().toLowerCase() === String(name).trim().toLowerCase();
    f.confirm.addEventListener('input', () => { btn.disabled = !same(); });
    setTimeout(() => f.confirm.focus(), 30);
    const go = async () => {
      if (!same()) return;
      busy(btn, true, 'Aguarde…');
      try { await run({ confirm: f.confirm.value, reason: withReason ? f.reason.value : undefined }); m.close(); }
      catch (e) { busy(btn, false); btn.disabled = !same(); fieldError(f, e.data && e.data.field, e.message); }
    };
    btn.addEventListener('click', go);
    f.addEventListener('submit', (e) => { e.preventDefault(); go(); });
  }
  function deleteOrgModal(o, id) {
    confirmNameModal({
      title: 'Excluir organização', name: o.name, button: 'Excluir organização', withReason: true,
      intro: `<p style="margin-bottom:8px"><b>${num(o.members)} ${o.members === 1 ? 'pessoa perde' : 'pessoas perdem'} o acesso na hora.</b> Quem também faz parte de outra organização continua entrando nela.</p>
        <p>Os dados ficam guardados por <b>30 dias</b>: nesse prazo dá para restaurar tudo ou baixar o backup aqui no console. Depois, somem de vez (junto com as contas que não fazem parte de outra organização).</p>`,
      run: async (b) => {
        await api(`/console/orgs/${encodeURIComponent(id)}/delete`, { method: 'POST', body: b });
        toast('Organização excluída. Fica guardada por 30 dias.');
        pageOrg(id);
      }
    });
  }
  function renderDeletedOrg(main, id, x) {
    const crumb = { href: '/console/organizacoes', label: 'Organizações' };
    main.innerHTML = pageHead(esc(x.name), `Excluída ${rel(x.deletedAt)}${x.deletedBy ? ` por ${esc(x.deletedBy)}` : ''}`, '', crumb) + `
      <div class="c-banner c-banner--bad">${icon('archive')}<div><b>Ninguém acessa esta organização.</b> Os dados ficam guardados até <b>${dateTime(x.purgeAt)}</b> (${x.daysLeft === 0 ? 'hoje' : x.daysLeft === 1 ? 'falta 1 dia' : `faltam ${x.daysLeft} dias`}) e depois são apagados de vez.</div></div>
      <section class="c-card">
        <div class="c-card-body">
          <dl class="c-dl c-dl--left">
            <dt>Dono</dt><dd>${x.owner ? `${esc(x.owner.name)}${x.owner.email ? ` · ${esc(x.owner.email)}` : ''}` : '—'}</dd>
            <dt>Pessoas</dt><dd>${num(x.members)}</dd>
            <dt>Plano</dt><dd>${esc(x.plan.name)} · ${esc(planLimits(x.plan))}</dd>
            <dt>Criada em</dt><dd>${x.createdAt ? dateTime(x.createdAt).split(',')[0] : '—'}</dd>
            <dt>Excluída em</dt><dd>${dateTime(x.deletedAt)}${x.deletedBy ? ` por ${esc(x.deletedBy)}` : ''}</dd>
            ${x.reason ? `<dt>Motivo</dt><dd>${esc(x.reason)}</dd>` : ''}
          </dl>
        </div>
        <div class="c-danger-row">
          <div><div class="c-danger-title">Restaurar</div><div class="c-hint">Volta tudo como estava: pessoas, squads, demandas, arquivos e plano.</div></div>
          <button class="c-btn c-btn--sm c-btn--primary" id="org-restore">${icon('rotate-ccw')}Restaurar</button>
        </div>
        <div class="c-danger-row">
          <div><div class="c-danger-title">Baixar backup</div><div class="c-hint">Arquivo JSON com tudo o que é da organização.</div></div>
          <a class="c-btn c-btn--sm" href="/api/console/orgs/${esc(id)}/export" download>${icon('download')}Baixar backup</a>
        </div>
        <div class="c-danger-row">
          <div><div class="c-danger-title">Apagar agora</div><div class="c-hint">Não espera os 30 dias. Não dá para desfazer.</div></div>
          <button class="c-btn c-btn--sm c-btn--danger" id="org-purge">${icon('trash-2')}Apagar de vez…</button>
        </div>
      </section>`;
    paint();
    document.getElementById('org-restore').addEventListener('click', async (e) => {
      busy(e.currentTarget, true, 'Restaurando…');
      try { await api(`/console/orgs/${encodeURIComponent(id)}/restore`, { method: 'POST' }); toast('Organização restaurada.'); pageOrg(id); }
      catch (err) { busy(e.currentTarget, false); fail(err); }
    });
    document.getElementById('org-purge').addEventListener('click', () => confirmNameModal({
      title: 'Apagar de vez', name: x.name, button: 'Apagar de vez',
      intro: `<p>Apaga agora, sem esperar os 30 dias: itens, convites, notificações, arquivos que só ela usava e as contas que não fazem parte de outra organização. <b>Não dá para desfazer.</b> Se quiser guardar uma cópia, baixe o backup antes.</p>`,
      run: async (b) => {
        const r = await api(`/console/orgs/${encodeURIComponent(id)}`, { method: 'DELETE', body: b });
        toast(`Apagada de vez: ${num(r.items)} itens, ${num(r.accounts)} contas, ${num(r.files)} arquivos.`);
        go('/console/organizacoes');
      }
    }));
  }

  /* ═════════════ Lista de espera ═════════════ */
  async function pageWaitlist() {
    const params = new URLSearchParams(location.search);
    const main = shell('waitlist', pageHead('Lista de espera', 'Agências que pediram acesso pelo formulário público.', `<a class="c-btn c-btn--sm" href="/acesso" target="_blank" rel="noopener">${icon('external-link')}Ver formulário</a>`) + `<div class="c-card"><div class="c-card-body">${skel(160)}</div></div>`);
    let d;
    try { d = await api('/console/access-requests'); }
    catch (e) { if (e.silent) return; return errorBlock(main, e, pageWaitlist); }
    state.wl.items = d.items; state.counts = d.counts; state.plans = d.plans;
    const wanted = params.get('id');
    if (wanted) {
      const r = d.items.find(x => x.id === wanted);
      if (r) { state.wl.selected = r.id; state.wl.filter = r.status; }
    }
    renderWaitlist(main);
  }
  function renderWaitlist(main) {
    const { items } = state.wl;
    const counts = { all: items.length, ...state.counts };
    const tabs = [['new', 'Novos'], ['reviewing', 'Em análise'], ['approved', 'Aprovados'], ['rejected', 'Recusados'], ['all', 'Todos']];
    const list = items.filter(r => state.wl.filter === 'all' || r.status === state.wl.filter);
    if (!list.some(r => r.id === state.wl.selected)) state.wl.selected = list[0] ? list[0].id : null;
    const sel = items.find(r => r.id === state.wl.selected);
    main.innerHTML = pageHead('Lista de espera', 'Agências que pediram acesso pelo formulário público.', `<a class="c-btn c-btn--sm" href="/acesso" target="_blank" rel="noopener">${icon('external-link')}Ver formulário</a>`) + `
      <div class="c-tabs" role="tablist">${tabs.map(([k, l]) => `<button class="c-tab${state.wl.filter === k ? ' is-active' : ''}" role="tab" aria-selected="${state.wl.filter === k}" data-filter="${k}">${l}<span class="c-tab-count">${num(counts[k] || 0)}</span></button>`).join('')}</div>
      ${items.length ? `<div class="c-wl">
        <section class="c-card c-wl-list">${list.length ? list.map(r => `
          <button class="c-wl-item${r.id === state.wl.selected ? ' is-active' : ''}" data-id="${esc(r.id)}">
            <span class="c-avatar">${esc(initials(r.name))}</span>
            <span class="c-wl-main"><span class="c-wl-top"><span class="c-wl-name">${esc(r.company)}</span><span class="c-wl-when">${rel(r.createdAt)}</span></span>
            <span class="c-wl-meta" style="display:block">${esc(r.name)} · ${esc(TEAM[r.teamSize] || r.teamSize)}</span></span>
          </button>`).join('') : `<div class="c-empty">Nenhum pedido nesta aba.</div>`}</section>
        <section class="c-card c-detail" id="wl-detail">${sel ? detailHTML(sel) : `<div class="c-empty">Escolha um pedido.</div>`}</section>
      </div>` : `<div class="c-card"><div class="c-empty">${icon('inbox')}<div>Nenhum pedido ainda.</div><div class="c-hint" style="margin-top:6px">Divulgue o formulário: <a href="/acesso" target="_blank" rel="noopener">${esc(location.origin)}/acesso</a></div></div></div>`}`;
    paint();
    main.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => { state.wl.filter = b.dataset.filter; state.wl.selected = null; renderWaitlist(main); }));
    main.querySelectorAll('.c-wl-item[data-id]').forEach(b => b.addEventListener('click', () => {
      state.wl.selected = b.dataset.id;
      history.replaceState(null, '', '/console/lista-de-espera?id=' + b.dataset.id);
      renderWaitlist(main);
      if (window.innerWidth < 1180) document.getElementById('wl-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
    if (sel) bindDetail(main, sel);
    const nav = document.querySelector('.c-nav a[href="/console/lista-de-espera"] .c-nav-count');
    if (nav) { if (state.counts.new) nav.textContent = state.counts.new; else nav.remove(); }
  }
  function detailHTML(r) {
    const fact = (k, v) => v ? `<div><div class="c-fact-k">${k}</div><div class="c-fact-v">${v}</div></div>` : '';
    const site = r.website ? (/^https?:\/\//i.test(r.website) ? r.website : 'https://' + r.website) : '';
    const next = {
      new: [['reviewing', 'Colocar em análise', 'search', ''], ['rejected', 'Recusar', 'x', 'c-btn--danger']],
      reviewing: [['rejected', 'Recusar', 'x', 'c-btn--danger'], ['new', 'Voltar para novos', 'undo-2', '']],
      approved: [['reviewing', 'Voltar para análise', 'undo-2', '']],
      rejected: [['reviewing', 'Reabrir', 'undo-2', '']]
    }[r.status] || [];
    return `<div class="c-detail-head"><span class="c-avatar">${esc(initials(r.name))}</span>
        <div style="flex:1;min-width:0"><div class="c-detail-name">${esc(r.company)}</div><div class="c-detail-company">${esc(r.name)}${r.role ? ` · ${esc(r.role)}` : ''}</div></div>${statusPill(r.status)}</div>
      <div class="c-detail-section"><div class="c-facts">
        ${fact('E-mail', `<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>`)}
        ${fact('Telefone', esc(r.phone))}
        ${fact('Tamanho da equipe', esc(TEAM[r.teamSize] || r.teamSize))}
        ${fact('Como conheceu', esc(SOURCE[r.source] || ''))}
        ${fact('Site', site ? `<a href="${esc(site)}" target="_blank" rel="noopener noreferrer">${esc(r.website)}</a>` : '')}
        ${fact('Pedido em', `${dateTime(r.createdAt)}${r.submissions > 1 ? ` · enviado ${r.submissions}×` : ''}`)}
      </div></div>
      ${r.message ? `<div class="c-detail-section"><div class="c-section-label">O que querem organizar</div><div class="c-quote">${esc(r.message)}</div></div>` : ''}
      <div class="c-detail-section"><div class="c-section-label">Decisão</div>
        <div class="c-actions">${next.map(([s, l, ic, cls]) => `<button class="c-btn c-btn--sm ${cls}" data-status="${s}">${icon(ic)}${l}</button>`).join('')}
          <button class="c-btn c-btn--sm c-btn--ghost" data-copy="${esc(r.email)}">${icon('copy')}Copiar e-mail</button></div>
        ${r.orgId
          ? (r.orgPurgedAt
            ? `<p class="c-hint" style="margin-top:10px">${icon('building-2')} A organização ${esc(r.orgName || '')} foi apagada de vez em ${dateTime(r.orgPurgedAt).split(',')[0]}.</p>`
            : `<p class="c-hint" style="margin-top:10px">${icon('building-2')} Organização <a href="/console/organizacoes/${esc(r.orgId)}" data-link>${esc(r.orgName || 'criada')}</a>: o convite de dono foi para ${esc(r.email)}.</p>`)
          : r.status !== 'rejected' ? `<button class="c-btn c-btn--primary c-btn--sm" style="margin-top:10px" data-create-org>${icon('building-2')}Aprovar e criar organização</button>
             <p class="c-hint" style="margin-top:8px">Cria a organização com um squad "Geral" e manda o convite de dono para ${esc(r.email)}.</p>` : ''}
      </div>
      <div class="c-detail-section"><div class="c-section-label">Anotações</div>
        <form id="wl-note" novalidate><textarea class="c-textarea" name="note" placeholder="Contexto, próxima conversa, impressões…" maxlength="2000"></textarea>
        <div style="display:flex;justify-content:flex-end;margin-top:8px"><button class="c-btn c-btn--sm" type="submit">Adicionar anotação</button></div></form>
        ${r.notes && r.notes.length ? `<ul class="c-timeline">${r.notes.slice().reverse().map(n => n.kind === 'status'
          ? `<li class="is-status"><div><div class="c-tl-text">${esc(n.by)} mudou para <b>${esc((STATUS[n.to] || { label: n.to }).label)}</b></div><div class="c-tl-meta">${dateTime(n.at)}</div></div></li>`
          : `<li><div><div class="c-tl-text">${esc(n.text)}</div><div class="c-tl-meta">${esc(n.by)} · ${dateTime(n.at)}</div></div></li>`).join('')}</ul>` : ''}
      </div>`;
  }
  function bindDetail(main, r) {
    const update = async (body, btn) => {
      if (btn) busy(btn, true, 'Salvando…');
      try {
        const upd = await api('/console/access-requests/' + encodeURIComponent(r.id), { method: 'PATCH', body });
        const i = state.wl.items.findIndex(x => x.id === r.id);
        const prev = state.wl.items[i].status;
        state.wl.items[i] = upd;
        if (prev !== upd.status) {
          state.counts[prev]--; state.counts[upd.status]++;
          // Acompanha o pedido até a aba da nova situação.
          if (state.wl.filter !== 'all') state.wl.filter = upd.status;
          state.wl.selected = upd.id;
          toast(`Pedido marcado como ${(STATUS[upd.status] || {}).label.toLowerCase()}.`);
        }
        renderWaitlist(main);
      } catch (e) { if (btn) busy(btn, false); fail(e); }
    };
    main.querySelectorAll('[data-status]').forEach(b => b.addEventListener('click', () => update({ status: b.dataset.status }, b)));
    main.querySelector('[data-create-org]')?.addEventListener('click', () => {
      const m = modal('Aprovar e criar organização', `<form id="f-org" novalidate>
          <div class="c-field"><label class="c-label" for="org-name">Nome da organização</label><input class="c-input" id="org-name" name="name" maxlength="80" value="${esc(r.company)}"></div>
          <div class="c-field"><label class="c-label" for="org-plan">Plano</label>
            <select class="c-select" id="org-plan" name="planId">${(state.plans || []).map(p => `<option value="${esc(p.id)}"${p.id === 'teste' ? ' selected' : ''}>${esc(p.name)} · ${esc(p.id === 'custom' ? 'sem limites (ajuste depois)' : p.trial ? '14 dias grátis' : planLimits(p))}</option>`).join('')}</select>
            <span class="c-hint">O teste de 14 dias começa quando o dono aceitar o convite. Tamanho da equipe informado: ${esc(TEAM[r.teamSize] || r.teamSize)}${TEAM_PLAN[r.teamSize] ? ` (plano provável depois: ${esc(((state.plans || []).find(p => p.id === TEAM_PLAN[r.teamSize]) || {}).name || '')})` : ''}.</span></div>
          <p class="c-hint">Criamos a organização com um squad "Geral" e o fluxo padrão, e <b>${esc(r.name)}</b> recebe o convite para criar a conta como dono.</p>
          <div class="c-error" role="alert" style="margin-top:10px"></div></form>`,
        `<button class="c-btn" data-close>Cancelar</button><button class="c-btn c-btn--primary" id="org-go">Criar e convidar</button>`);
      const f = m.el.querySelector('#f-org');
      setTimeout(() => f.name.select(), 30);
      const go = async () => {
        const btn = m.el.querySelector('#org-go');
        busy(btn, true, 'Criando…');
        try {
          const out = await api(`/console/access-requests/${encodeURIComponent(r.id)}/create-org`, { method: 'POST', body: { name: f.name.value, planId: f.planId ? f.planId.value : undefined } });
          m.close();
          const i = state.wl.items.findIndex(x => x.id === r.id);
          const prev = state.wl.items[i].status;
          state.wl.items[i] = out.request;
          if (prev !== 'approved') { state.counts[prev]--; state.counts.approved++; }
          if (state.wl.filter !== 'all') state.wl.filter = 'approved';
          state.wl.selected = r.id;
          renderWaitlist(main);
          if (out.emailSent) toast(`Organização criada. Convite enviado para ${r.email}.`);
          else linkModal('Organização criada', `O envio de e-mail não está configurado. Mande este link para ${esc(r.name)} criar a conta como dono de ${esc(out.org.name)}:`, out.link);
        } catch (e) { busy(btn, false); fieldError(f, e.data && e.data.field, e.message); }
      };
      m.el.querySelector('#org-go').addEventListener('click', go);
      f.addEventListener('submit', (e) => { e.preventDefault(); go(); });
    });
    main.querySelector('[data-copy]')?.addEventListener('click', (e) => copy(e.currentTarget.dataset.copy, 'E-mail'));
    const f = document.getElementById('wl-note');
    f.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const text = f.note.value.trim();
      if (!text) return f.note.focus();
      update({ note: text }, f.querySelector('button'));
    });
  }

  /* ═════════════ Superadmins ═════════════ */
  function modal(title, body, foot) {
    const back = document.createElement('div');
    back.className = 'c-modal-back';
    back.innerHTML = `<div class="c-modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="c-modal-head"><div class="c-modal-title">${esc(title)}</div><button class="c-icon-btn" data-close aria-label="Fechar">${icon('x')}</button></div><div class="c-modal-body">${body}</div>${foot ? `<div class="c-modal-foot">${foot}</div>` : ''}</div>`;
    document.body.appendChild(back);
    const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('[data-close]')) close(); });
    paint();
    return { el: back, close };
  }
  function linkModal(title, text, link) {
    const m = modal(title, `<p style="font-size:13.5px;color:var(--text-dim)">${text}</p><div class="c-linkbox">${esc(link)}</div><p class="c-hint">Vale por 48 horas e só pode ser usado uma vez.</p>`,
      `<button class="c-btn" data-close>Fechar</button><button class="c-btn c-btn--primary" id="m-copy">${icon('copy')}Copiar link</button>`);
    m.el.querySelector('#m-copy').addEventListener('click', () => { copy(link, 'Link'); m.close(); });
  }
  async function pageAdmins() {
    const addBtn = `<button class="c-btn c-btn--primary c-btn--sm" id="add-admin">${icon('user-plus')}Adicionar superadmin</button>`;
    const main = shell('admins', pageHead('Superadmins', 'Quem tem acesso a este console. Contas separadas das contas do reWork.', addBtn) + `<div class="c-card"><div class="c-card-body">${skel(120)}</div></div>`);
    let d;
    try { d = await api('/console/admins'); }
    catch (e) { if (e.silent) return; return errorBlock(main, e, pageAdmins); }
    const meRow = d.items.find(a => a.id === d.me) || {};
    const left = meRow.recoveryLeft || 0;
    const accountCard = meRow.twoFactorExempt ? `
      <section class="c-card c-account">
        <div class="c-account-main">
          <div class="c-card-title">Sua conta: acesso padrão</div>
          <div class="c-account-facts">
            <span class="c-pill c-pill--warn">${icon('shield-alert')}Sem verificação em duas etapas</span>
          </div>
          <p class="c-hint" style="margin-top:8px">1. Adicione o seu superadmin pessoal · 2. Entre com ele e cadastre o app · 3. Desative este acesso na lista abaixo.</p>
        </div>
        <div class="c-actions">
          <button class="c-btn c-btn--sm c-btn--primary" id="acc-add">${icon('user-plus')}Adicionar superadmin</button>
          <button class="c-btn c-btn--sm" id="acc-pass">${icon('lock')}Trocar senha</button>
        </div>
      </section>` : null;
    main.innerHTML = pageHead('Superadmins', 'Quem tem acesso a este console. Contas separadas das contas do reWork.', addBtn) + (accountCard || `
      <section class="c-card c-account">
        <div class="c-account-main">
          <div class="c-card-title">Sua conta</div>
          <div class="c-account-facts">
            <span class="c-pill c-pill--good">${icon('smartphone')}App autenticador</span>
            ${left > 3 ? `<span class="c-pill c-pill--good">${icon('key-round')}${left} códigos de recuperação</span>`
              : left > 0 ? `<span class="c-pill c-pill--warn">${icon('key-round')}Só ${left} ${left === 1 ? 'código' : 'códigos'} de recuperação</span>`
              : `<span class="c-pill c-pill--bad">${icon('triangle-alert')}Sem códigos de recuperação</span>`}
          </div>
          ${left <= 3 ? `<p class="c-hint" style="margin-top:8px">${d.items.filter(a => a.active !== false && a.twoFactor).length <= 1 ? 'Você é o único superadmin: sem códigos, perder o celular só se resolve pelo servidor.' : 'Gere códigos novos para não depender de outro superadmin se perder o celular.'}</p>` : ''}
        </div>
        <div class="c-actions">
          <button class="c-btn c-btn--sm${left <= 3 ? ' c-btn--primary' : ''}" id="acc-codes">${icon('key-round')}Gerar códigos novos</button>
          <button class="c-btn c-btn--sm" id="acc-pass">${icon('lock')}Trocar senha</button>
        </div>
      </section>`) + `
      <section class="c-card"><div class="c-table-wrap"><table class="c-table">
        <thead><tr><th>Nome</th><th>Verificação em duas etapas</th><th>Situação</th><th>Último acesso</th><th></th></tr></thead>
        <tbody>${d.items.map(a => {
          const status = a.active === false ? '<span class="c-pill">Desativado</span>'
            : a.twoFactorExempt ? '<span class="c-pill c-pill--warn">Ativo · acesso padrão</span>'
            : a.pendingActivation || !a.twoFactor ? '<span class="c-pill c-pill--warn">Aguardando ativação</span>' : '<span class="c-pill c-pill--good">Ativo</span>';
          const mine = a.id === d.me;
          const actions = mine ? '<span class="c-cell-sub">Você</span>' : `<div class="c-actions" style="justify-content:flex-end">
            ${a.active !== false && !a.twoFactorExempt ? `<button class="c-btn c-btn--sm" data-reset="${a.id}" title="Gera um link para criar senha e cadastrar o app de novo">${icon('key-round')}Novo link</button>` : ''}
            <button class="c-btn c-btn--sm ${a.active !== false ? 'c-btn--danger' : ''}" data-toggle="${a.id}" data-active="${a.active !== false}">${a.active !== false ? 'Desativar' : 'Reativar'}</button></div>`;
          return `<tr><td><div class="c-cell-main">${esc(a.name)}</div><div class="c-cell-sub">${esc(a.email)}</div></td>
            <td>${a.twoFactor ? `<span class="c-pill c-pill--good">${icon('smartphone')}App cadastrado</span>` : a.twoFactorExempt ? '<span class="c-pill">Não usa</span>' : '<span class="c-pill">Pendente</span>'}</td>
            <td>${status}</td><td>${rel(a.lastLoginAt)}</td><td style="text-align:right">${actions}</td></tr>`;
        }).join('')}</tbody></table></div></section>`;
    paint();
    document.getElementById('add-admin').addEventListener('click', () => {
      const m = modal('Adicionar superadmin', `<form id="f-admin" novalidate>
          <div class="c-field"><label class="c-label" for="ad-name">Nome</label><input class="c-input" id="ad-name" name="name" autocomplete="off"></div>
          <div class="c-field"><label class="c-label" for="ad-email">E-mail</label><input class="c-input" id="ad-email" name="email" type="email" autocomplete="off"></div>
          <p class="c-hint">A pessoa recebe um link para criar a senha e cadastrar o app autenticador. Superadmins veem todas as organizações e a lista de espera.</p>
          <div class="c-error" role="alert" style="margin-top:10px"></div></form>`,
        `<button class="c-btn" data-close>Cancelar</button><button class="c-btn c-btn--primary" id="ad-save">Enviar convite</button>`);
      const f = m.el.querySelector('#f-admin');
      setTimeout(() => f.name.focus(), 30);
      const save = async () => {
        const btn = m.el.querySelector('#ad-save');
        busy(btn, true, 'Enviando…');
        try {
          const r = await api('/console/admins', { method: 'POST', body: { name: f.name.value, email: f.email.value } });
          m.close();
          if (r.emailSent) toast(`Convite enviado para ${r.admin.email}.`);
          else linkModal('Convite criado', 'O envio de e-mail não está configurado. Mande este link para a pessoa por um canal seguro:', r.link);
          pageAdmins();
        } catch (e) { busy(btn, false); fieldError(f, e.data && e.data.field, e.message); }
      };
      m.el.querySelector('#ad-save').addEventListener('click', save);
      f.addEventListener('submit', (e) => { e.preventDefault(); save(); });
    });
    document.getElementById('acc-add')?.addEventListener('click', () => document.getElementById('add-admin').click());
    document.getElementById('acc-codes')?.addEventListener('click', () => {
      const m = modal('Gerar códigos novos', `<form id="f-codes" novalidate>
          <p style="font-size:13.5px;color:var(--text-dim);margin-bottom:14px">Os códigos antigos deixam de valer. Confirme com o código atual do app autenticador.</p>
          <div class="c-field"><label class="c-label" for="gc-code">Código do app</label><input class="c-input c-code-input" id="gc-code" name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="000000"></div>
          <div class="c-error" role="alert"></div></form>`,
        `<button class="c-btn" data-close>Cancelar</button><button class="c-btn c-btn--primary" id="gc-go">Gerar</button>`);
      const f = m.el.querySelector('#f-codes');
      setTimeout(() => f.code.focus(), 30);
      const go = async () => {
        const btn = m.el.querySelector('#gc-go');
        busy(btn, true, 'Gerando…');
        try {
          const r = await api('/console/me/recovery-codes', { method: 'POST', body: { code: f.code.value.replace(/\D/g, '') } });
          m.close();
          const shown = modal('Seus códigos de recuperação', `<p style="font-size:13.5px;color:var(--text-dim);margin-bottom:14px">Guarde agora: eles não aparecem de novo. Cada um substitui o código do app uma vez.</p>${recoveryCodesHTML(r.recoveryCodes)}`,
            `<button class="c-btn c-btn--primary" data-close>Já guardei</button>`);
          bindRecoveryCodes(shown.el, r.recoveryCodes);
          pageAdmins();
        } catch (e) { busy(btn, false); fieldError(f, 'code', e.message); }
      };
      m.el.querySelector('#gc-go').addEventListener('click', go);
      f.addEventListener('submit', (e) => { e.preventDefault(); go(); });
    });
    document.getElementById('acc-pass').addEventListener('click', () => {
      const min = (state.status && state.status.passwordMin) || 12;
      const m = modal('Trocar senha', `<form id="f-pw" novalidate>
          <div class="c-field"><label class="c-label" for="pw-cur">Senha atual</label><input class="c-input" id="pw-cur" name="current" type="password" autocomplete="current-password"></div>
          <div class="c-field"><label class="c-label" for="pw-new">Nova senha</label><input class="c-input" id="pw-new" name="password" type="password" autocomplete="new-password" placeholder="Mínimo de ${min} caracteres"></div>
          ${meRow.twoFactorExempt ? '' : `<div class="c-field"><label class="c-label" for="pw-code">Código do app</label><input class="c-input c-code-input" id="pw-code" name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="000000"></div>`}
          <p class="c-hint">As suas outras sessões do console são encerradas.</p>
          <div class="c-error" role="alert" style="margin-top:10px"></div></form>`,
        `<button class="c-btn" data-close>Cancelar</button><button class="c-btn c-btn--primary" id="pw-go">Salvar</button>`);
      const f = m.el.querySelector('#f-pw');
      setTimeout(() => f.current.focus(), 30);
      const go = async () => {
        const btn = m.el.querySelector('#pw-go');
        if (f.password.value.length < min) return fieldError(f, 'password', `A senha precisa ter pelo menos ${min} caracteres.`);
        busy(btn, true, 'Salvando…');
        try {
          await api('/console/me/password', { method: 'POST', body: { current: f.current.value, password: f.password.value, code: f.code ? f.code.value.replace(/\D/g, '') : '' } });
          m.close();
          toast('Senha trocada.');
        } catch (e) { busy(btn, false); fieldError(f, e.data && e.data.field, e.message); }
      };
      m.el.querySelector('#pw-go').addEventListener('click', go);
      f.addEventListener('submit', (e) => { e.preventDefault(); go(); });
    });
    main.querySelectorAll('[data-reset]').forEach(b => b.addEventListener('click', async () => {
      busy(b, true, '…');
      try {
        const r = await api(`/console/admins/${b.dataset.reset}/reset`, { method: 'POST' });
        if (r.emailSent) toast(`Novo link enviado para ${r.admin.email}.`);
        else linkModal('Novo link de ativação', 'A senha e o app anteriores deixaram de valer. Mande este link para a pessoa por um canal seguro:', r.link);
        pageAdmins();
      } catch (e) { busy(b, false); fail(e); }
    }));
    main.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', async () => {
      const activate = b.dataset.active !== 'true';
      busy(b, true, '…');
      try { await api(`/console/admins/${b.dataset.toggle}`, { method: 'PATCH', body: { active: activate } }); toast(activate ? 'Superadmin reativado.' : 'Superadmin desativado.'); pageAdmins(); }
      catch (e) { busy(b, false); fail(e); }
    }));
  }

  /* ═════════════ Auditoria ═════════════ */
  const ACTIONS = {
    console_setup: 'Configurou o console', login: 'Entrou', logout: 'Saiu',
    login_failed: 'Senha errada ao entrar', two_factor_failed: 'Código de verificação errado',
    two_factor_enabled: 'Cadastrou o app autenticador', org_viewed: 'Abriu uma organização',
    request_status: 'Mudou a situação de um pedido', request_note: 'Anotou num pedido',
    admin_invited: 'Convidou um superadmin', admin_reset: 'Gerou novo link de ativação',
    admin_activated: 'Ativou o próprio acesso', admin_deactivated: 'Desativou um superadmin', admin_reactivated: 'Reativou um superadmin',
    recovery_code_used: 'Entrou com código de recuperação', recovery_code_failed: 'Código de recuperação errado',
    recovery_codes_issued: 'Gerou códigos de recuperação novos', password_changed: 'Trocou a senha',
    password_reset_requested: 'Pediu para redefinir a senha', password_reset: 'Redefiniu a senha por e-mail',
    server_recovery: 'Acesso recuperado pelo servidor', server_recovery_failed: 'Recuperação pelo servidor com código errado',
    org_created: 'Criou uma organização', org_owner_changed: 'Trocou o dono de uma organização'
  };
  const WARN_ACTIONS = new Set(['login_failed', 'two_factor_failed', 'recovery_code_failed', 'server_recovery_failed', 'server_recovery', 'recovery_code_used']);
  function auditDetails(e) {
    const d = e.details || {};
    if (e.action === 'recovery_code_used') return `Restam ${num(d.left)}`;
    if (e.action === 'login' && d.via === 'recovery_code') return 'Com código de recuperação';
    if (e.action === 'request_status') return `${esc(d.email)}: ${esc((STATUS[d.from] || { label: d.from }).label)} → ${esc((STATUS[d.to] || { label: d.to }).label)}`;
    if (e.action === 'org_owner_changed') return `${esc(d.name)} → ${esc(d.owner)}`;
    if (e.action === 'org_created') return `${esc(d.name)} · dono: ${esc(d.email)}`;
    if (e.action === 'org_viewed') return esc(d.name || '');
    if (d.email) return esc(d.email);
    return '';
  }
  async function pageAudit() {
    const main = shell('audit', pageHead('Auditoria', 'Tudo o que foi feito neste console, do mais recente ao mais antigo.') + `<div class="c-card"><div class="c-card-body">${skel(200)}</div></div>`);
    let d;
    try { d = await api('/console/audit?limit=300'); }
    catch (e) { if (e.silent) return; return errorBlock(main, e, pageAudit); }
    main.innerHTML = pageHead('Auditoria', 'Tudo o que foi feito neste console, do mais recente ao mais antigo.') + `
      <section class="c-card">${d.items.length ? `<div class="c-table-wrap"><table class="c-table">
        <thead><tr><th>Quando</th><th>Quem</th><th>Ação</th><th>Detalhes</th><th>IP</th></tr></thead>
        <tbody>${d.items.map(e => `<tr><td style="white-space:nowrap">${dateTime(e.at)}</td><td>${esc(e.adminName || '—')}</td>
          <td>${WARN_ACTIONS.has(e.action) ? `<span class="c-pill c-pill--warn">${icon('triangle-alert')}${esc(ACTIONS[e.action] || e.action)}</span>` : esc(ACTIONS[e.action] || e.action)}</td>
          <td class="c-cell-sub">${auditDetails(e) || '—'}</td><td class="mono c-cell-sub">${esc(e.ip || '')}</td></tr>`).join('')}</tbody></table></div>`
        : `<div class="c-empty">Nada registrado ainda.</div>`}</section>`;
    paint();
  }

  route();
})();
