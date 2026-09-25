/* Formulário público da lista de espera (/acesso). Grava em
   POST /api/access-requests; o reWork Console revisa os pedidos. */
(function () {
  'use strict';
  const f = document.getElementById('f');
  const err = document.getElementById('err');
  const btn = document.getElementById('send');
  const openedAt = Date.now();
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function invalid(field, msg) {
    f.querySelectorAll('.is-invalid').forEach(el => el.classList.remove('is-invalid'));
    const el = field === 'consent' ? document.getElementById('consent-row') : f.elements[field];
    if (el) { el.classList.add('is-invalid'); if (field !== 'consent') el.focus(); }
    err.textContent = msg;
  }

  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.textContent = '';
    f.querySelectorAll('.is-invalid').forEach(el => el.classList.remove('is-invalid'));
    const v = (k) => (f.elements[k].value || '').trim();
    const body = {
      name: v('name'), email: v('email'), company: v('company'), role: v('role'),
      teamSize: v('teamSize'), phone: v('phone'), website: v('website'), source: v('source'),
      message: v('message'), consent: f.elements.consent.checked,
      company_site: v('company_site'), elapsedMs: Date.now() - openedAt
    };
    if (body.name.length < 2) return invalid('name', 'Informe seu nome.');
    if (!EMAIL_RE.test(body.email)) return invalid('email', 'Informe um e-mail válido.');
    if (body.company.length < 2) return invalid('company', 'Informe o nome da empresa ou agência.');
    if (!body.teamSize) return invalid('teamSize', 'Escolha o tamanho da equipe.');
    if (!body.consent) return invalid('consent', 'Marque a concordância para enviar.');
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    try {
      const res = await fetch('/api/access-requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      let data = null;
      try { data = await res.json(); } catch {}
      if (!res.ok) {
        btn.disabled = false; btn.textContent = 'Pedir acesso';
        if (data && data.field) return invalid(data.field, data.error);
        err.textContent = (data && data.error) || 'Não foi possível enviar agora. Tente de novo.';
        return;
      }
      f.hidden = true;
      document.getElementById('done-text').textContent = `Obrigado, ${body.name.split(/\s+/)[0]}! Vamos analisar o pedido e responder em ${body.email}. Fique de olho na caixa de entrada (e no spam).`;
      document.getElementById('done').hidden = false;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch {
      btn.disabled = false; btn.textContent = 'Pedir acesso';
      err.textContent = 'Sem conexão com o servidor. Tente de novo.';
    }
  });
})();
