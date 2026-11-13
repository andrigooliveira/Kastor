/* Página do briefing de criativo (/hub/briefing/<id>).
 * Estado em memória + salvamento automático (PUT com baseVersion).
 * Render por strings; cada input/botão aponta pra uma função guardada em
 * `binds`/`acts` (refeitos a cada render), sem caminhos em texto. */
(function () {
  'use strict';
  const BS = window.BriefingSchema;
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ORG = new URLSearchParams(location.search).get('org') || '';
  const BID = (location.pathname.match(/\/hub\/briefing\/([a-zA-Z0-9]+)/) || [])[1];

  const S = {
    rec: null, data: null, clients: [], blocks: null, agent: null, canManageAgent: false, sel: 'campanha', adding: false,
    telaIdx: {}, preview: false, checkOpen: false, clientQuery: '',
    saveTimer: null, saving: false, pendingSave: false, lastSavedAt: null, conflict: null
  };
  let binds = [], acts = [];

  /* ── API ── */
  async function api(path, method, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (ORG) headers['X-Org-Id'] = ORG;
    const res = await fetch('/api' + path, { method: method || 'GET', credentials: 'same-origin', headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { location.href = '/?next=' + encodeURIComponent(location.pathname + location.search); throw new Error('Não autenticado'); }
    if (!res.ok) { const e = new Error(data.error || ('Erro ' + res.status)); e.status = res.status; e.body = data; throw e; }
    return data;
  }
  function toast(msg, isError) {
    const t = $('bf-toast');
    t.textContent = msg; t.hidden = false; t.classList.toggle('is-error', !!isError);
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 3200);
  }
  const icons = () => { if (window.lucide) window.lucide.createIcons(); };

  /* ── Helpers de estado ── */
  const canEdit = () => !!(S.rec && S.rec.canEdit);
  const client = () => S.clients.find(c => c.id === S.data.clienteId) || null;
  const pieceById = id => S.data.pecas.find(p => p.id === id);
  const bind = (get, set) => { binds.push({ get, set }); return binds.length - 1; };
  const act = fn => { acts.push(fn); return acts.length - 1; };

  /* ── Salvamento ── */
  function changed(opts) {
    if (!canEdit()) return;
    setSave('Alterações não salvas');
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(save, 700);
    refreshSide(opts && opts.full);
  }
  async function save(extra) {
    if (S.saving) { S.pendingSave = true; return; }
    if (S.conflict) return;
    S.saving = true; setSave('Salvando…');
    try {
      const body = Object.assign({ data: S.data, baseVersion: S.rec.version }, extra || {});
      const rec = await api('/briefings/' + S.rec.id, 'PUT', body);
      S.rec.version = rec.version; S.rec.status = rec.status; S.rec.updatedBy = rec.updatedBy; S.rec.updatedAt = rec.updatedAt;
      S.lastSavedAt = new Date(); setSave('Salvo');
      renderTop();
    } catch (e) {
      if (e.status === 409 && e.body && e.body.current) { S.conflict = e.body.current; renderBanner(); setSave('Não salvo'); }
      else { setSave('Erro ao salvar'); toast(e.message || 'Falha ao salvar', true); }
    } finally {
      S.saving = false;
      if (S.pendingSave) { S.pendingSave = false; save(); }
    }
  }
  function setSave(t) { $('bf-save').textContent = t; }
  function renderBanner() {
    const b = $('bf-banner');
    if (!S.conflict) { b.hidden = true; return; }
    const who = S.conflict.updatedBy ? S.conflict.updatedBy.name : 'Outra pessoa';
    b.innerHTML = `<i data-lucide="users" class="ic-sm"></i><span><strong>${esc(who)}</strong> alterou este briefing enquanto você editava.</span>
      <button class="btn btn-sm btn-primary" id="bf-take-theirs">Carregar a versão de ${esc(who.split(' ')[0])}</button>
      <button class="btn btn-sm btn-ghost" id="bf-keep-mine">Manter a minha</button>`;
    b.hidden = false; icons();
    $('bf-take-theirs').onclick = () => { S.rec = S.conflict; S.data = S.conflict.data; S.conflict = null; renderBanner(); renderAll(); setSave('Atualizado'); };
    $('bf-keep-mine').onclick = () => { S.rec.version = S.conflict.version; S.conflict = null; renderBanner(); save(); };
  }

  /* ── Topo ── */
  function renderTop() {
    const d = S.data, rec = S.rec;
    $('bf-title').textContent = (d.campanha || 'Campanha sem nome') + (client() ? ' · ' + client().name : '');
    document.title = 'Briefing · ' + (d.campanha || 'reWork');
    if (rec.demand) {
      $('bf-back-label').textContent = rec.demand.name || 'Demanda';
      $('bf-back').href = (ORG ? '/' + ORG : '') + (rec.demand.path || '/');
    }
    const st = $('bf-status'); st.hidden = false;
    st.textContent = rec.status === 'pronto' ? 'Pronto' : 'Rascunho';
    st.classList.toggle('is-ready', rec.status === 'pronto');
    const rb = $('bf-ready-btn');
    rb.hidden = !canEdit();
    rb.className = 'btn btn-sm ' + (rec.status === 'pronto' ? 'btn-ghost' : 'btn-primary');
    rb.innerHTML = rec.status === 'pronto' ? '<i data-lucide="rotate-ccw" class="ic-sm"></i><span>Voltar para rascunho</span>' : '<i data-lucide="check" class="ic-sm"></i><span>Marcar como pronto</span>';
    if (!canEdit()) setSave('Somente leitura');
    icons();
  }

  /* ── Navegação lateral ── */
  function pieceSummary(p) {
    const n = p.telas.length;
    return [p.formatos.join(', ') || 'sem formato', n > 1 ? n + ' telas' : ''].filter(Boolean).join(' · ');
  }
  function renderNav() {
    const chk = BS.check(S.data, { client: client(), blocks: S.blocks });
    const pend = new Set(chk.missing.concat(chk.alerts).map(x => x.where));
    const campPend = ['campanha', 'objetivo', 'entrega', 'cliente', 'referencias'].some(w => pend.has(w));
    let h = `<button class="bf-nav-item ${S.sel === 'campanha' && !S.adding ? 'is-on' : ''}" data-a="${act(() => { S.sel = 'campanha'; S.adding = false; })}">
      <span class="bf-nav-ic"><i data-lucide="megaphone" class="ic-sm"></i></span>
      <span class="bf-nav-txt"><strong>Campanha</strong><small>${esc(S.data.campanha || 'Dados comuns a todas as peças')}</small></span>
      <span class="bf-dot ${campPend ? 'is-pending' : ''}"></span></button>`;
    h += `<div class="bf-nav-label"><span>Peças</span><span>${S.data.pecas.length}</span></div>`;
    S.data.pecas.forEach((p, i) => {
      const t = BS.pieceType(p.tipo);
      h += `<button class="bf-nav-item ${S.sel === p.id && !S.adding ? 'is-on' : ''}" data-a="${act(() => { S.sel = p.id; S.adding = false; })}" ${canEdit() ? 'draggable="true"' : ''} data-piece="${p.id}">
        <span class="bf-nav-ic"><i data-lucide="${t.icon}" class="ic-sm"></i></span>
        <span class="bf-nav-txt"><strong>${esc(BS.pieceTitle(p, i))}</strong><small>${esc(pieceSummary(p))}</small></span>
        <span class="bf-dot ${pend.has('peca:' + p.id) ? 'is-pending' : ''}"></span></button>`;
    });
    if (canEdit()) h += `<button class="bf-add-piece" data-a="${act(() => { S.adding = true; })}"><i data-lucide="plus" class="ic-sm"></i>Adicionar peça</button>`;
    const nMiss = chk.missing.length, nAl = chk.alerts.length;
    const go = where => () => {
      if (where.startsWith('peca:')) S.sel = where.slice(5); else S.sel = 'campanha';
      if (where === 'pecas') S.adding = true; else S.adding = false;
    };
    h += agentLine();
    h += `<div class="bf-check">
      <button class="bf-check-head ${chk.ok ? 'is-ok' : ''}" data-a="${act(() => { S.checkOpen = !S.checkOpen; })}">
        <i data-lucide="${chk.ok ? 'circle-check' : 'list-checks'}" class="ic-sm"></i>
        <span>${chk.ok ? 'Tudo preenchido' : [nMiss ? `${nMiss} ${nMiss > 1 ? 'itens faltando' : 'item faltando'}` : '', nAl ? `${nAl} ${nAl > 1 ? 'alertas' : 'alerta'}` : ''].filter(Boolean).join(' · ')}</span>
      </button>
      ${!chk.ok && S.checkOpen ? `<ul>${chk.alerts.map(a => `<li class="is-alert"><button data-a="${act(go(a.where))}">⚠ ${esc(a.text)}</button></li>`).join('')}${chk.missing.map(m => `<li><button data-a="${act(go(m.where))}">${esc(m.label)}</button></li>`).join('')}</ul>` : ''}
    </div>`;
    $('bf-nav').innerHTML = h;
  }

  /* ── Widgets ── */
  function fieldWrap(f, inner, extraHint) {
    return `<div class="bf-field"><div class="bf-label">${esc(f.label)}${f.required ? '<span class="bf-req" title="Obrigatório">*</span>' : ''}</div>${inner}${f.hint || extraHint ? `<div class="bf-hint">${esc(f.hint || extraHint)}</div>` : ''}</div>`;
  }
  function chipsSingle(options, get, set, opts) {
    opts = opts || {};
    let h = '<div class="bf-chips">';
    for (const o0 of options) {
      // String tem .small() (método antigo do JS): normaliza antes de ler.
      const o = typeof o0 === 'string' ? { value: o0, label: o0 } : o0;
      const val = o.value, label = o.label;
      h += `<button type="button" class="bf-chip ${opts.cls || ''} ${get() === val ? 'is-on' : ''}" data-a="${act(() => { set(get() === val ? '' : val); changed({ full: true }); })}">${o.swatch ? `<span class="bf-swatch" style="background:${esc(o.swatch)}"></span>` : ''}${esc(label)}${o.small ? ` <small>${esc(o.small)}</small>` : ''}</button>`;
    }
    if (opts.other) {
      h += `<button type="button" class="bf-chip ${get() === '__outro__' ? 'is-on' : ''}" data-a="${act(() => { set(get() === '__outro__' ? '' : '__outro__'); changed({ full: true }); })}">Outro</button>`;
    }
    h += '</div>';
    if (opts.other && get() === '__outro__') {
      h += `<input class="form-control bf-other" placeholder="Qual?" value="${esc(opts.other.get())}" data-b="${bind(opts.other.get, opts.other.set)}">`;
    }
    return h;
  }
  function chipsMulti(options, get, set) {
    let h = '<div class="bf-chips">';
    for (const o of options) {
      const on = get().includes(o.value);
      h += `<button type="button" class="bf-chip ${on ? 'is-on' : ''}" data-a="${act(() => {
        const cur = get().slice();
        const i = cur.indexOf(o.value);
        if (i >= 0) cur.splice(i, 1); else cur.push(o.value);
        set(cur); changed({ full: true });
      })}">${esc(o.label)}${o.small ? ` <small>${esc(o.small)}</small>` : ''}</button>`;
    }
    return h + '</div>';
  }
  function textInput(get, set, f, type) {
    return `<input class="form-control" type="${type || 'text'}" value="${esc(get() || '')}" placeholder="${esc((f && f.placeholder) || '')}" data-b="${bind(get, set)}">`;
  }
  function textArea(get, set, f) {
    return `<textarea class="form-control" rows="${(f && f.rows) || 3}" placeholder="${esc((f && f.placeholder) || '')}" data-b="${bind(get, set)}">${esc(get() || '')}</textarea>`;
  }
  /* Campo de texto exato com "Criação sugere" (e, no CTA, "Não tem"). */
  function copyField(label, c, opts) {
    opts = opts || {};
    const off = c.sugerir || c.naoSeAplica;
    const tg = (key, txt) => `<button type="button" class="bf-toggle ${c[key] ? 'is-on' : ''}" data-a="${act(() => {
      const nv = !c[key]; c.sugerir = false; c.naoSeAplica = false; c[key] = nv; if (opts.onTouch) opts.onTouch(); changed({ full: true });
    })}">${key === 'sugerir' ? '<i data-lucide="sparkles" class="ic-xs"></i>' : ''}${txt}</button>`;
    let h = `<div class="bf-field"><div class="bf-copy-head"><div class="bf-label">${esc(label)}${opts.required ? '<span class="bf-req">*</span>' : ''}</div>${tg('sugerir', 'Criação sugere')}${opts.allowNone ? tg('naoSeAplica', opts.noneLabel || 'Não tem') : ''}</div>`;
    if (off) h += `<div class="bf-copy-off">${c.sugerir ? 'A criação escreve este texto.' : (opts.noneText || 'Não tem.')}</div>`;
    else if (opts.multiline) h += `<textarea class="form-control" rows="3" placeholder="${esc(opts.placeholder || '')}" data-b="${bind(() => c.texto, v => { c.texto = v; })}">${esc(c.texto || '')}</textarea>`;
    else h += `<input class="form-control" value="${esc(c.texto || '')}" placeholder="${esc(opts.placeholder || '')}" data-b="${bind(() => c.texto, v => { c.texto = v; })}">`;
    return h + '</div>';
  }
  function tagsField(label, arr, placeholder) {
    const id = 'tg' + act(() => {});
    const h = `<div class="bf-field"><div class="bf-label">${esc(label)}</div><div class="bf-tags">${arr.map((t, i) => `<span class="bf-tag">${esc(t)}<button type="button" title="Remover" data-a="${act(() => { arr.splice(i, 1); changed({ full: true }); })}">×</button></span>`).join('')}<input id="${id}" placeholder="${esc(placeholder)}" data-tags="${act(v => { v.split(',').map(s => s.trim()).filter(Boolean).forEach(s => { if (!arr.includes(s)) arr.push(s); }); changed({ full: true }); })}"></div><div class="bf-hint">Enter ou vírgula para adicionar.</div></div>`;
    return h;
  }
  function renderGenericField(f, obj) {
    const get = () => obj[f.key], set = v => { obj[f.key] = v; };
    switch (f.type) {
      case 'text': return fieldWrap(f, textInput(get, set, f));
      case 'url': return fieldWrap(f, textInput(get, set, f, 'url'));
      case 'date': return fieldWrap(f, `<input class="form-control" type="date" style="max-width:200px" value="${esc(get() || '')}" data-b="${bind(get, set)}" data-full="1">`);
      case 'textarea': return fieldWrap(f, textArea(get, set, f));
      case 'single': return fieldWrap(f, chipsSingle(f.options, get, set, f.other ? { other: { get: () => obj[f.key + 'Outro'] || '', set: v => { obj[f.key + 'Outro'] = v; } } } : {}));
      case 'month': return fieldWrap(f, chipsSingle(BS.MONTHS.map((m, i) => ({ value: String(i + 1), label: m })), () => String(get() || ''), set, { cls: 'bf-chip-month' }));
      case 'client': {
        const q = S.clientQuery.trim().toLowerCase();
        const list = S.clients.filter(c => !q || c.name.toLowerCase().includes(q) || (c.sigla || '').toLowerCase().includes(q) || c.id === get());
        const search = S.clients.length > 10 ? `<input class="form-control bf-search" placeholder="Buscar cliente" value="${esc(S.clientQuery)}" data-b="${bind(() => S.clientQuery, v => { S.clientQuery = v; })}" data-rerender="1">` : '';
        const c = client();
        const hint = c && !c.sigla ? `Sigla usada no nome dos arquivos: ${BS.clientSigla(c)} (dá para definir no cadastro do cliente).` : '';
        return fieldWrap(f, search + chipsSingle(list.map(x => ({ value: x.id, label: x.name, swatch: x.color, small: x.sigla || '' })), get, v => { if ((v || null) !== get()) S.data.camposCliente = {}; set(v || null); }), hint);
      }
    }
    return '';
  }

  /* ── Página: Campanha ── */
  function renderCampaign() {
    const d = S.data;
    let h = `<div class="bf-page"><div class="bf-page-head"><span class="bf-head-ic"><i data-lucide="megaphone"></i></span><h1>Campanha</h1></div>`;
    for (const g of BS.CAMPAIGN_GROUPS) {
      if (g.id === 'referencias') h += renderClientBlock();
      h += `<section class="bf-card" id="sec-${g.id}"><h2 class="bf-card-title">${esc(g.label)}</h2>`;
      for (const f of g.fields) {
        if (!BS.visible(f, d)) continue;
        if (f.key === 'acao') {
          h += fieldWrap(f, chipsSingle(f.options, () => d.acao, v => { d.acao = v; }, { other: { get: () => d.acaoOutro, set: v => { d.acaoOutro = v; } } }));
          continue;
        }
        h += renderGenericField(f, d);
      }
      h += '</section>';
    }
    if (!d.pecas.length && canEdit()) {
      h += `<div class="bf-empty">Agora adicione as peças desta campanha.<br><button class="btn btn-primary btn-sm" data-a="${act(() => { S.adding = true; })}"><i data-lucide="plus" class="ic-sm"></i>Adicionar peça</button></div>`;
    }
    return h + '</div>';
  }
  function renderClientBlock() {
    const block = BS.clientBlock(client(), S.blocks);
    if (!block) return '';
    const cc = S.data.camposCliente || (S.data.camposCliente = {});
    let h = `<section class="bf-card" id="sec-cliente"><h2 class="bf-card-title"><i data-lucide="building-2" class="ic-sm"></i>Só do cliente · ${esc(client().name)}${block.origem === 'agente' ? '<span class="bf-card-origin"><i data-lucide="git-branch" class="ic-xs"></i>do Agente de Criação</span>' : ''}</h2>`;
    if (block.note) h += `<div class="bf-card-note">${esc(block.note)}</div>`;
    for (const f of block.fields) {
      if (!BS.visible(f, cc)) continue;
      h += renderGenericField(f, cc);
    }
    return h + '</section>';
  }

  /* ── Escolha do tipo de peça ── */
  function renderAddPiece() {
    let h = `<div class="bf-page"><div class="bf-page-head"><span class="bf-head-ic"><i data-lucide="plus"></i></span><h1>Que peça você quer adicionar?</h1></div><div class="bf-types">`;
    for (const t of BS.PIECE_TYPES) {
      h += `<button class="bf-type" data-a="${act(() => {
        const p = BS.newPiece(t.id);
        const blk = BS.clientBlock(client(), S.blocks);
        if (blk && blk.proibidas && blk.proibidas.length) p.proibidas = blk.proibidas.slice();
        S.data.pecas.push(p); S.sel = p.id; S.adding = false; S.telaIdx[p.id] = 0; changed({ full: true });
      })}"><span class="bf-type-ic"><i data-lucide="${t.icon}"></i></span><strong>${esc(t.label)}</strong><small>${esc(t.desc)}</small></button>`;
    }
    return h + '</div></div>';
  }

  /* ── Página: Peça ── */
  function renderPiece(p) {
    const t = BS.pieceType(p.tipo);
    const idx = S.data.pecas.indexOf(p);
    const c = client();
    const n = p.telas.length;
    let ti = Math.min(S.telaIdx[p.id] || 0, n - 1);
    S.telaIdx[p.id] = ti;
    const tela = p.telas[ti];
    let h = `<div class="bf-page"><div class="bf-page-head"><span class="bf-head-ic"><i data-lucide="${t.icon}"></i></span>
      <div style="flex:1;min-width:0"><div class="bf-top-kicker">Peça ${String(idx + 1).padStart(2, '0')} · ${esc(t.label)}</div>
      <input class="bf-name-input" placeholder="${esc(t.label)} (dê um nome, se quiser)" value="${esc(p.nome)}" data-b="${bind(() => p.nome, v => { p.nome = v; })}"></div>
      ${canEdit() ? `<div class="bf-head-actions">
        <button class="bf-icon-btn" title="Duplicar peça" data-a="${act(() => {
          const cp = JSON.parse(JSON.stringify(p)); cp.id = Math.random().toString(36).slice(2, 10);
          cp.telas.forEach(x => { x.id = Math.random().toString(36).slice(2, 10); });
          S.data.pecas.splice(idx + 1, 0, cp); S.sel = cp.id; changed({ full: true }); toast('Peça duplicada');
        })}"><i data-lucide="copy" class="ic-sm"></i></button>
        <button class="bf-icon-btn is-danger" title="Excluir peça" data-a="${act(async () => {
          if (!(await confirmBox('Excluir esta peça?', `${BS.pieceTitle(p, idx)} e as ${n} tela(s) dela saem do briefing.`, 'Excluir'))) return;
          S.data.pecas.splice(idx, 1); S.sel = S.data.pecas[Math.max(0, idx - 1)]?.id || 'campanha'; changed({ full: true }); renderAll();
        })}"><i data-lucide="trash-2" class="ic-sm"></i></button></div>` : ''}
    </div>`;

    // Formatos
    h += `<section class="bf-card"><h2 class="bf-card-title">Formatos</h2>`;
    h += chipsMulti(t.formats.map(f => ({ value: f, label: BS.FORMATS[f].label, small: BS.formatSize(f, c, S.blocks) })), () => p.formatos, v => { p.formatos = v; });
    if (p.formatos.length > 1) h += `<div class="bf-hint">O primeiro marcado (${esc(p.formatos[0])}) é o principal.</div>`;
    h += '</section>';

    // Telas (no carrossel/story, o que é geral vem antes delas)
    const multi = t.telas.max > 1;
    const hHead = h; h = '';
    h += `<section class="bf-card"><h2 class="bf-card-title">${n > 1 || t.telas.max > 1 ? 'Telas e textos' : 'Textos e imagem'}</h2>`;
    if (t.telas.max > 1) {
      h += `<div class="bf-screens-bar"><span class="bf-label" style="margin:0">Quantas telas</span>
        <span class="bf-stepper"><button type="button" ${n <= t.telas.min ? 'disabled' : ''} data-a="${act(async () => {
          const last = p.telas[n - 1];
          const hasContent = (last.titulo.texto || last.apoio.texto || last.informacoes || last.imagens.length);
          if (hasContent && !(await confirmBox('Remover a última tela?', 'Ela já tem texto ou imagem.', 'Remover'))) return;
          p.telas.pop(); BS.syncCtas(p); changed({ full: true }); renderAll();
        })}">−</button><span>${n}</span><button type="button" ${n >= t.telas.max ? 'disabled' : ''} data-a="${act(() => {
          const prevLast = p.telas[n - 1];
          if (prevLast && !prevLast._ctaTouched && !prevLast.cta.texto && !prevLast.cta.sugerir) prevLast.cta.naoSeAplica = true;
          p.telas.push(BS.newTela()); BS.syncCtas(p); S.telaIdx[p.id] = p.telas.length - 1; changed({ full: true });
        })}">+</button></span></div>`;
    }
    if (n > 1) {
      h += '<div class="bf-tabs">' + p.telas.map((x, i) => {
        const done = BS.copyFilled(x.titulo) && BS.copyFilled(x.cta) && (x.semImagem || x.imagens.length);
        return `<button type="button" class="bf-tab ${i === ti ? 'is-on' : ''}" data-a="${act(() => { S.telaIdx[p.id] = i; })}"><span class="bf-dot ${done ? '' : 'is-pending'}"></span>${esc(BS.telaLabel(p, i))}</button>`;
      }).join('') + '</div>';
    }
    h += `<p class="bf-exact"><i data-lucide="type" class="ic-xs"></i>Escreva exatamente como deve aparecer na arte, com acento e pontuação.</p>`;
    if (ti > 0 && canEdit()) {
      h += `<button type="button" class="bf-link-btn" style="margin:-6px 0 12px" data-a="${act(() => {
        const prev = p.telas[ti - 1];
        const keep = tela.id;
        const cp = JSON.parse(JSON.stringify(prev)); cp.id = keep;
        p.telas[ti] = cp; changed({ full: true }); toast('Copiado da tela anterior');
      })}"><i data-lucide="copy-plus" class="ic-xs"></i>Repetir o conteúdo da tela anterior</button>`;
    }
    h += copyField('Título', tela.titulo, { required: true, placeholder: 'Ex.: SEU NOVO ENDEREÇO EM HORTOLÂNDIA' });
    h += copyField('Texto de apoio', tela.apoio, { placeholder: 'Opcional', multiline: true, allowNone: true });
    h += fieldWrap({ label: 'Informações' }, textArea(() => tela.informacoes, v => { tela.informacoes = v; }, { placeholder: '93 m²\n3 quartos, sendo 1 suíte\n2 vagas', rows: 3 }), 'Uma por linha, da mais para a menos importante.');
    h += copyField('Chamada / botão (CTA)', tela.cta, { required: true, placeholder: 'Ex.: AGENDE SUA VISITA', allowNone: true, noneLabel: 'Sem CTA nesta tela', noneText: 'Esta tela não tem chamada.', onTouch: () => { tela._ctaTouched = true; } });
    h += renderImages(tela);
    h += '</section>';
    const hTelas = h; h = '';

    // Detalhes da peça (valem para todas as telas)
    h += multi
      ? `<section class="bf-card"><h2 class="bf-card-title">Vale para todas as telas</h2><p class="bf-exact"><i data-lucide="layers" class="ic-xs"></i>Legenda, palavras, oferta e texto legal são do ${esc(t.label.toLowerCase())} inteiro, não de cada tela.</p>`
      : `<section class="bf-card"><h2 class="bf-card-title">Detalhes da peça</h2>`;
    for (const fid of t.fields) {
      const def = BS.PIECE_EXTRA_FIELDS[fid];
      if (def.type === 'copy') h += copyField(def.label, p[fid], { multiline: def.multiline, placeholder: def.placeholder });
      else h += fieldWrap(def, textInput(() => p[fid], v => { p[fid] = v; }, def));
    }
    h += `<div class="bf-row">${fieldWrap({ label: 'Oferta / condição' }, textInput(() => p.oferta, v => { p.oferta = v; }, { placeholder: 'Ex.: R$ 1.234,56 · 10% off · bônus' }))}
      ${fieldWrap({ label: 'Validade da oferta' }, `<input class="form-control" type="date" value="${esc(p.validade)}" data-b="${bind(() => p.validade, v => { p.validade = v; })}" data-full="1">`)}</div>`;
    if (S.data.objetivo === 'Evento' || p.evento.data || p.evento.local) {
      h += `<div class="bf-row">${fieldWrap({ label: 'Data do evento', required: S.data.objetivo === 'Evento' }, `<input class="form-control" type="date" value="${esc(p.evento.data)}" data-b="${bind(() => p.evento.data, v => { p.evento.data = v; })}" data-full="1">`)}
        ${fieldWrap({ label: 'Horário' }, `<input class="form-control" type="time" value="${esc(p.evento.hora)}" data-b="${bind(() => p.evento.hora, v => { p.evento.hora = v; })}">`)}</div>`;
      h += fieldWrap({ label: 'Local do evento', required: S.data.objetivo === 'Evento' }, textInput(() => p.evento.local, v => { p.evento.local = v; }, { placeholder: 'Ex.: Apartamento modelo na torre' }));
    }
    h += `<div class="bf-field"><div class="bf-copy-head"><div class="bf-label">Texto legal</div>
      <button type="button" class="bf-toggle ${p.legal.padrao ? 'is-on' : ''}" data-a="${act(() => { p.legal.padrao = !p.legal.padrao; changed({ full: true }); })}">Padrão do cliente</button></div>
      ${p.legal.padrao ? '<div class="bf-copy-off">Usa o texto legal padrão do cliente.</div>' : textArea(() => p.legal.texto, v => { p.legal.texto = v; }, { placeholder: 'Texto legal exato desta peça' })}</div>`;
    h += `<div class="bf-row">${tagsField('Palavras que precisam aparecer', p.obrigatorias, 'Ex.: Hortolândia')}${tagsField('Palavras ou assuntos proibidos', p.proibidas, 'Ex.: renda')}</div>`;
    h += fieldWrap({ label: 'Observação para a criação' }, textArea(() => p.obs, v => { p.obs = v; }, { placeholder: 'Algo mais que a criação precisa saber sobre esta peça', rows: 2 }));
    h += '</section>';
    return hHead + (multi ? h + hTelas : hTelas + h) + '</div>';
  }

  function renderImages(tela) {
    let h = `<div class="bf-field"><div class="bf-copy-head"><div class="bf-label">Imagens<span class="bf-req">*</span></div>
      <button type="button" class="bf-toggle ${tela.semImagem ? 'is-on' : ''}" data-a="${act(() => { tela.semImagem = !tela.semImagem; changed({ full: true }); })}">Sem imagem</button></div>`;
    if (tela.semImagem) return h + '<div class="bf-copy-off">Esta tela não usa imagem.</div></div>';
    h += '<div class="bf-images">';
    tela.imagens.forEach((im, i) => {
      const src = im.url ? im.url + (im.url.startsWith('/uploads/') ? '?w=480' : '') : (im.link && /\.(png|jpe?g|webp|gif)(\?|$)/i.test(im.link) ? im.link : '');
      h += `<div class="bf-image"><div class="bf-image-thumb" ${src ? `style="background-image:url('${esc(src)}')"` : ''}>${src ? '' : '<i data-lucide="link"></i>'}</div>
        <div class="bf-image-body">
          ${im.url ? `<div class="bf-image-name">${esc(im.name || 'imagem')}</div>` : `<input class="form-control" placeholder="Link da imagem" value="${esc(im.link || '')}" data-b="${bind(() => im.link, v => { im.link = v; })}" data-full="1">`}
          <div><div class="bf-label" style="margin-bottom:5px">O que é</div>${chipsSingle(BS.IMAGE_TYPES, () => im.tipo, v => { im.tipo = v; })}</div>
          <input class="form-control" placeholder="O que mostra. Ex.: varanda gourmet do apto de 93 m²" value="${esc(im.mostra || '')}" data-b="${bind(() => im.mostra, v => { im.mostra = v; })}">
          <div><div class="bf-label" style="margin-bottom:5px">Uso</div>${chipsSingle(BS.IMAGE_USES, () => im.uso, v => { im.uso = v; })}</div>
        </div>
        ${canEdit() ? `<button type="button" class="bf-icon-btn is-danger" title="Remover imagem" data-a="${act(() => { tela.imagens.splice(i, 1); changed({ full: true }); })}"><i data-lucide="x" class="ic-sm"></i></button>` : ''}
      </div>`;
    });
    if (canEdit()) {
      h += `<div class="bf-drop" data-drop="${act(files => uploadImages(tela, files))}">
        <button type="button" class="btn btn-ghost btn-sm" data-a="${act(() => pickFiles(tela))}"><i data-lucide="upload" class="ic-sm"></i>Enviar imagem</button>
        <span>ou arraste aqui, ou</span>
        <button type="button" class="bf-link-btn" data-a="${act(() => { tela.imagens.push({ id: Math.random().toString(36).slice(2, 10), link: '', tipo: '', mostra: '', uso: tela.imagens.length ? '' : 'Principal' }); changed({ full: true }); })}">colar um link</button>
      </div>`;
    }
    return h + '</div></div>';
  }
  function pickFiles(tela) {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
    inp.onchange = () => uploadImages(tela, inp.files);
    inp.click();
  }
  async function uploadImages(tela, files) {
    const list = Array.from(files || []).filter(f => /^image\//.test(f.type));
    if (!list.length) return;
    toast(list.length > 1 ? `Enviando ${list.length} imagens…` : 'Enviando imagem…');
    for (const f of list) {
      try {
        const dataUri = await new Promise((ok, ko) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = ko; r.readAsDataURL(f); });
        const saved = await api('/uploads', 'POST', { name: f.name, data: dataUri });
        tela.imagens.push({ id: Math.random().toString(36).slice(2, 10), url: saved.url, name: f.name, tipo: '', mostra: '', uso: tela.imagens.length ? '' : 'Principal' });
        changed({ full: true }); renderAll();
      } catch (e) { toast(e.message || 'Falha ao enviar', true); }
    }
  }

  /* ── Render ── */
  function renderMain() {
    binds = []; acts = [];
    let h;
    if (S.adding) h = renderAddPiece();
    else if (S.sel !== 'campanha' && pieceById(S.sel)) h = renderPiece(pieceById(S.sel));
    else { S.sel = 'campanha'; h = renderCampaign(); }
    const main = $('bf-main');
    main.innerHTML = h;
    // Somente leitura (freelancer): trava os campos, mas as abas das telas
    // continuam navegáveis.
    if (!canEdit()) main.querySelectorAll('input, textarea, button:not(.bf-tab)').forEach(el => { el.disabled = true; });
  }
  function renderAll() {
    const main = $('bf-main');
    const scroll = main.scrollTop;
    const focusB = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.b : null;
    renderMain(); renderNav(); renderTop(); renderPreview(); icons();
    main.scrollTop = scroll;
    if (focusB != null) {
      const el = main.querySelector(`[data-b="${focusB}"]`);
      if (el) { el.focus(); if (el.setSelectionRange && el.type !== 'date' && el.type !== 'time' && el.type !== 'url') { const L = el.value.length; try { el.setSelectionRange(L, L); } catch (_) {} } }
    }
  }
  // Depois de digitar: atualiza só o lado (navegação, título, prévia).
  // A navegação acrescenta ações em `acts` sem apagar as do formulário.
  function refreshSide(full) {
    if (full) return; // o clique já chama renderAll
    clearTimeout(refreshSide._t);
    refreshSide._t = setTimeout(() => { renderNav(); renderTop(); renderPreview(); icons(); }, 250);
  }
  function renderPreview() {
    const grid = $('bf-grid'), pane = $('bf-preview');
    grid.classList.toggle('has-preview', S.preview);
    pane.hidden = !S.preview;
    $('bf-preview-btn').classList.toggle('is-on', S.preview);
    if (!S.preview) return;
    clearTimeout(renderPreview._t);
    renderPreview._t = setTimeout(() => {
      const fr = $('bf-preview-frame');
      const html = BS.toHtml(S.data, { client: client(), blocks: S.blocks }).replace('<body>', '<body style="padding:20mm 18mm;max-width:174mm;margin:0 auto;background:#fff">');
      const y = fr.contentWindow ? fr.contentWindow.scrollY : 0;
      fr.srcdoc = html;
      fr.onload = () => { try { fr.contentWindow.scrollTo(0, y); } catch (_) {} };
    }, 200);
  }

  /* ── Modal de confirmação ── */
  function confirmBox(title, msg, okLabel, listItems) {
    return new Promise(resolve => {
      const m = $('bf-modal');
      m.innerHTML = `<div class="bf-modal" role="dialog" aria-modal="true"><h2>${esc(title)}</h2>${msg ? `<p>${esc(msg)}</p>` : ''}${listItems && listItems.length ? `<ul>${listItems.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        <div class="bf-modal-actions"><button class="btn btn-ghost btn-sm" data-r="0">Cancelar</button><button class="btn btn-primary btn-sm" data-r="1">${esc(okLabel || 'OK')}</button></div></div>`;
      m.hidden = false;
      const done = v => { m.hidden = true; m.innerHTML = ''; resolve(v); };
      m.onclick = e => { const r = e.target.closest('[data-r]'); if (r) done(r.dataset.r === '1'); else if (e.target === m) done(false); };
      m.querySelector('[data-r="1"]').focus();
    });
  }

  /* ── Eventos (delegação) ── */
  function wire() {
    document.addEventListener('click', async e => {
      if (!e.target.closest('.bf-menu-wrap')) $('bf-export-menu').hidden = true;
      const a = e.target.closest('[data-a]');
      if (!a || a.disabled) return;
      const fn = acts[Number(a.dataset.a)];
      if (!fn) return;
      e.preventDefault();
      await fn();
      renderAll();
    });
    const onInput = e => {
      const el = e.target;
      if (el.dataset.b == null) return;
      const b = binds[Number(el.dataset.b)];
      if (!b) return;
      b.set(el.value);
      if (el.dataset.rerender) { renderAll(); return; }
      changed({ full: !!el.dataset.full });
      if (el.dataset.full) renderAll();
    };
    document.addEventListener('input', e => { if (e.target.type !== 'date' && e.target.type !== 'url' && !(e.target.dataset.full)) onInput(e); else if (e.target.dataset.rerender) onInput(e); });
    document.addEventListener('change', e => { if (e.target.type === 'date' || e.target.type === 'url' || e.target.dataset.full) onInput(e); });
    document.addEventListener('keydown', e => {
      const el = e.target;
      if (el.dataset && el.dataset.tags != null && (e.key === 'Enter' || e.key === ',')) {
        e.preventDefault();
        const v = el.value.trim();
        if (!v) return;
        const fn = acts[Number(el.dataset.tags)];
        el.value = '';
        const id = el.id;
        fn(v); renderAll();
        const again = document.getElementById(id); if (again) again.focus();
      }
      if (e.key === 'Escape') { $('bf-export-menu').hidden = true; }
    });
    // Peças: arrastar para reordenar
    let dragId = null;
    document.addEventListener('dragstart', e => { const it = e.target.closest && e.target.closest('[data-piece]'); if (it) { dragId = it.dataset.piece; e.dataTransfer.effectAllowed = 'move'; } });
    document.addEventListener('dragover', e => {
      const it = e.target.closest && e.target.closest('[data-piece]');
      const drop = e.target.closest && e.target.closest('[data-drop]');
      if (it && dragId) { e.preventDefault(); document.querySelectorAll('.bf-nav-item.is-drop').forEach(x => x.classList.remove('is-drop')); it.classList.add('is-drop'); }
      if (drop && e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) { e.preventDefault(); drop.classList.add('is-over'); }
    });
    document.addEventListener('dragleave', e => { const drop = e.target.closest && e.target.closest('[data-drop]'); if (drop) drop.classList.remove('is-over'); });
    document.addEventListener('drop', e => {
      const drop = e.target.closest && e.target.closest('[data-drop]');
      if (drop && e.dataTransfer.files.length) { e.preventDefault(); drop.classList.remove('is-over'); acts[Number(drop.dataset.drop)](e.dataTransfer.files); return; }
      const it = e.target.closest && e.target.closest('[data-piece]');
      if (it && dragId && it.dataset.piece !== dragId) {
        e.preventDefault();
        const arr = S.data.pecas;
        const from = arr.findIndex(p => p.id === dragId), to = arr.findIndex(p => p.id === it.dataset.piece);
        const [m] = arr.splice(from, 1); arr.splice(to, 0, m);
        changed({ full: true }); renderAll();
      }
      dragId = null;
    });
    document.addEventListener('dragend', () => { dragId = null; document.querySelectorAll('.is-drop,.is-over').forEach(x => x.classList.remove('is-drop', 'is-over')); });

    $('bf-preview-btn').onclick = () => { S.preview = !S.preview; try { localStorage.setItem('bf-preview', S.preview ? '1' : '0'); } catch (_) {} renderPreview(); };
    $('bf-export-btn').onclick = e => { e.stopPropagation(); $('bf-export-menu').hidden = !$('bf-export-menu').hidden; };
    $('bf-export-menu').onclick = e => { const b = e.target.closest('[data-fmt]'); if (b) { $('bf-export-menu').hidden = true; doExport(b.dataset.fmt); } };
    $('bf-ready-btn').onclick = async () => {
      if (S.rec.status === 'pronto') { await flushSave(); await save({ status: 'rascunho' }); return; }
      const chk = BS.check(S.data, { client: client(), blocks: S.blocks });
      if (!chk.ok) {
        const items = chk.alerts.map(a => '⚠ ' + a.text).concat(chk.missing.map(m => 'Falta: ' + m.label));
        const ok = await confirmBox('Marcar como pronto mesmo assim?', 'O agente vai perguntar o que estiver faltando.', 'Marcar como pronto', items);
        if (!ok) return;
      }
      await flushSave(); await save({ status: 'pronto' });
      toast('Briefing pronto');
    };
    window.addEventListener('beforeunload', e => { if (S.saveTimer && $('bf-save').textContent !== 'Salvo') { flushSave(); e.preventDefault(); e.returnValue = ''; } });
  }
  async function flushSave() { if (S.saveTimer) { clearTimeout(S.saveTimer); S.saveTimer = null; } }

  async function doExport(fmt) {
    try {
      await flushSave(); await save();
      toast(fmt === 'docx' ? 'Gerando o Word…' : 'Gerando o arquivo…');
      const headers = ORG ? { 'X-Org-Id': ORG } : {};
      const res = await fetch('/api/briefings/' + S.rec.id + '/export?format=' + fmt, { credentials: 'same-origin', headers });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'Falha ao exportar'); }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const m = /filename\*=UTF-8''([^;]+)/.exec(cd);
      const name = m ? decodeURIComponent(m[1]) : 'briefing.' + fmt;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } catch (e) { toast(e.message, true); }
  }

  /* ── Agente de Criação (campos por cliente vindos do GitHub) ── */
  function applyClients(cl) {
    S.clients = cl.clients || []; S.blocks = cl.blocks || null; S.agent = cl.agent || null; S.canManageAgent = !!cl.canManageAgent;
  }
  async function reloadClients() { applyClients(await api('/briefings/' + BID + '/clients')); renderAll(); }
  function relTime(iso) {
    if (!iso) return 'nunca';
    const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
    if (m < 1) return 'agora'; if (m < 60) return 'há ' + m + ' min';
    const h = Math.round(m / 60); if (h < 24) return 'há ' + h + ' h';
    return 'há ' + Math.round(h / 24) + ' d';
  }
  function agentLine() {
    if (!S.agent) {
      return S.canManageAgent ? `<button class="bf-agent bf-agent-connect" data-a="${act(openAgentConfig)}"><i data-lucide="git-branch" class="ic-xs"></i>Ligar ao Agente de Criação</button>` : '';
    }
    const n = S.blocks ? Object.keys(S.blocks).length : 0;
    return `<div class="bf-agent ${S.agent.error ? 'has-error' : ''}" title="${esc(S.agent.repo + (S.agent.commit ? ' @ ' + S.agent.commit : ''))}">
      <i data-lucide="${S.agent.error ? 'triangle-alert' : 'git-branch'}" class="ic-xs"></i>
      <span>Agente de Criação · ${n} ${n === 1 ? 'cliente' : 'clientes'} · ${esc(relTime(S.agent.syncedAt))}</span>
      ${S.canManageAgent ? `<button class="bf-icon-btn" title="Atualizar agora" data-a="${act(syncAgent)}"><i data-lucide="refresh-cw" class="ic-xs"></i></button><button class="bf-icon-btn" title="Configurar" data-a="${act(openAgentConfig)}"><i data-lucide="settings-2" class="ic-xs"></i></button>` : ''}
    </div>${S.agent.error ? `<div class="bf-agent-err">${esc(S.agent.error)}</div>` : ''}`;
  }
  async function syncAgent() {
    toast('Atualizando do GitHub…');
    try { await api('/org/briefing-agent/sync', 'POST'); await reloadClients(); toast('Campos do agente atualizados'); }
    catch (e) { await reloadClients().catch(() => {}); toast(e.message, true); }
  }
  async function openAgentConfig() {
    let cur = { repo: 'wsicriacao/agente-criacao', branch: 'main', path: 'base/clientes', hasToken: false, connected: false };
    try { cur = Object.assign(cur, await api('/org/briefing-agent')); } catch (_) {}
    const m = $('bf-modal');
    m.innerHTML = `<div class="bf-modal" role="dialog" aria-modal="true">
      <h2>Agente de Criação</h2>
      <p>O reWork lê <code>&lt;pasta&gt;/&lt;cliente&gt;/briefing.json</code> do repositório e usa os campos "Só do cliente", os avisos e as palavras proibidas de cada um. A lista de clientes continua vindo do reWork.</p>
      <div class="bf-field"><div class="bf-label">Repositório</div><input class="form-control" id="ag-repo" value="${esc(cur.repo)}" placeholder="dono/nome"></div>
      <div class="bf-row"><div class="bf-field"><div class="bf-label">Branch</div><input class="form-control" id="ag-branch" value="${esc(cur.branch)}"></div>
      <div class="bf-field"><div class="bf-label">Pasta dos clientes</div><input class="form-control" id="ag-path" value="${esc(cur.path)}"></div></div>
      <div class="bf-field"><div class="bf-label">Token do GitHub</div><input class="form-control" id="ag-token" type="password" autocomplete="off" placeholder="${cur.hasToken ? 'Salvo. Deixe em branco para manter' : 'github_pat_…'}">
        <div class="bf-hint">Fine-grained token só deste repositório, com "Contents: Read-only". Fica cifrado no servidor.</div></div>
      <div class="bf-agent-err" id="ag-err" hidden></div>
      <div class="bf-modal-actions">${cur.connected ? '<button class="btn btn-ghost btn-sm" data-r="off" style="margin-right:auto">Desligar</button>' : ''}<button class="btn btn-ghost btn-sm" data-r="0">Cancelar</button><button class="btn btn-primary btn-sm" data-r="1">Salvar e ler agora</button></div></div>`;
    m.hidden = false;
    const close = () => { m.hidden = true; m.innerHTML = ''; };
    m.onclick = async e => {
      const r = e.target.closest('[data-r]');
      if (!r) { if (e.target === m) close(); return; }
      if (r.dataset.r === '0') return close();
      if (r.dataset.r === 'off') { await api('/org/briefing-agent', 'DELETE'); close(); await reloadClients(); toast('Agente desligado: voltam os campos padrão'); return; }
      r.disabled = true; r.textContent = 'Lendo o repositório…';
      try {
        await api('/org/briefing-agent', 'PUT', { repo: $('ag-repo').value, branch: $('ag-branch').value, path: $('ag-path').value, token: $('ag-token').value });
        close(); await reloadClients(); toast('Agente de Criação ligado');
      } catch (err) {
        const el = $('ag-err'); el.textContent = err.message; el.hidden = false;
        r.disabled = false; r.textContent = 'Salvar e ler agora';
      }
    };
    setTimeout(() => $('ag-token') && $('ag-token').focus(), 50);
  }

  /* ── Início ── */
  async function boot() {
    if (!BID) { $('bf-main').innerHTML = '<div class="bf-loading">Briefing não encontrado.</div>'; return; }
    try {
      const [rec, cl] = await Promise.all([api('/briefings/' + BID), api('/briefings/' + BID + '/clients')]);
      S.rec = rec; S.data = rec.data; applyClients(cl);
      try { S.preview = localStorage.getItem('bf-preview') === '1'; } catch (_) {}
      if (S.data.pecas.length && new URLSearchParams(location.search).get('peca')) S.sel = new URLSearchParams(location.search).get('peca');
      wire(); renderAll();
      setSave(canEdit() ? (rec.updatedBy ? 'Editado por ' + rec.updatedBy.name.split(' ')[0] : '') : 'Somente leitura');
    } catch (e) {
      $('bf-main').innerHTML = `<div class="bf-loading">${esc(e.message || 'Não foi possível abrir o briefing.')}</div>`;
    }
  }
  boot();
})();
