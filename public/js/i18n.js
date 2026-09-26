/* ───────────────────────────────────────────────────────────────
   reWork — Idiomas (i18n)

   O português é a língua-fonte: o próprio texto em PT é a chave do
   dicionário (public/i18n/<lang>.js). Chaves com {0}, {1}… são padrões
   (o texto variável fica no lugar dos números).

   No navegador:
     - o idioma vem do localStorage (o /api/me grava lá o idioma efetivo:
       o da pessoa, senão o da organização); sem ele, ?lang= ou o idioma
       do navegador. Português não carrega nada além deste arquivo.
     - em outro idioma, carrega o dicionário e traduz a página conforme ela
       é montada (MutationObserver): textos e atributos de interface
       (placeholder, title, aria-label…). Conteúdo editável, <textarea>,
       <code> e o que tiver translate="no" ficam como estão.
     - T(texto) traduz strings que não passam pelo DOM (confirm, alert…).

   No Node (server.js / e-mails): require('./public/js/i18n.js') devolve
   { createTranslator, langForCountry, … }.
   ─────────────────────────────────────────────────────────────── */
(function (root) {
  'use strict';

  const LANGS = ['pt', 'en'];
  const LOCALES = { pt: 'pt-BR', en: 'en-US' };
  // Países de língua portuguesa → português; o resto → inglês.
  const PT_COUNTRIES = ['BR', 'PT', 'AO', 'MZ', 'CV', 'GW', 'ST', 'TL'];
  // ISO 3166-1 alfa-2 (o nome de cada um vem do Intl.DisplayNames no idioma da tela).
  const COUNTRIES = ('AD AE AF AG AI AL AM AO AR AS AT AU AW AZ BA BB BD BE BF BG BH BI BJ BM BN BO BR BS BT BW BY BZ CA CD CF CG CH CI CL CM CN CO CR CU CV CW CY CZ ' +
    'DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FM FR GA GB GD GE GH GI GL GM GN GQ GR GT GU GW GY HK HN HR HT HU ID IE IL IN IQ IR IS IT JM JO JP KE KG KH KI KM KN KR KW KY KZ ' +
    'LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MH MK ML MM MN MO MR MT MU MV MW MX MY MZ NA NE NG NI NL NO NP NR NZ OM PA PE PG PH PK PL PR PS PT PW PY QA RO RS RU RW ' +
    'SA SB SC SD SE SG SI SK SL SM SN SO SR SS ST SV SY SZ TD TG TH TJ TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VG VN VU WS YE ZA ZM ZW').split(' ');
  const validCountry = (c) => { const u = String(c || '').toUpperCase(); return COUNTRIES.indexOf(u) >= 0 ? u : null; };
  const langForCountry = (c) => (c && PT_COUNTRIES.indexOf(String(c).toUpperCase()) === -1 ? 'en' : 'pt');
  const validLang = (l) => (LANGS.indexOf(l) >= 0 ? l : null);
  // Formato de data/número do inglês segue o país (en-GB, en-AU…), com en-US de padrão.
  function localeFor(lang, country) {
    if (lang !== 'en') return LOCALES[lang] || 'pt-BR';
    const c = String(country || '').toUpperCase();
    if (/^[A-Z]{2}$/.test(c) && c !== 'US') {
      try { const l = 'en-' + c; if (Intl.DateTimeFormat.supportedLocalesOf([l]).length) return l; } catch (e) {}
    }
    return 'en-US';
  }

  const norm = (s) => String(s).replace(/[\s ]+/g, ' ').trim();
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const WORD_RE = /[A-Za-zÀ-ÖØ-öø-ÿ]{2,}/g;

  /* ── Tradutor: exato + padrões ── */
  function createTranslator(dict) {
    const exact = new Map();
    const byWord = new Map();
    const outputs = new Set();
    const cache = new Map();
    for (const k in dict) {
      const v = dict[k];
      if (typeof v !== 'string' || !v) continue;
      const key = norm(k);
      // Todo item vale para T(chave, …valores); os com {0} viram também padrões
      // para o texto já montado — menos os genéricos demais ("{0} de {1}"),
      // que só valem chamados pelo T().
      exact.set(key, v);
      if (/\{\d+\}/.test(key) && key.replace(/\{\d+\}/g, '').replace(/[^A-Za-zÀ-ÿ]/g, '').length >= 3) compile(key, v);
      outputs.add(norm(v));
    }
    function compile(key, v) {
      const parts = key.split(/(\{\d+\})/);
      let re = '^';
      const order = [];
      let litLen = 0;
      for (const p of parts) {
        const m = /^\{(\d+)\}$/.exec(p);
        if (m) { re += '(.*?)'; order.push(+m[1]); }
        else { re += escRe(p).replace(/ /g, '\\s+'); litLen += p.replace(/\s/g, '').length; }
      }
      const words = (key.replace(/\{\d+\}/g, ' ').match(WORD_RE) || []).map(w => w.toLowerCase());
      if (!words.length) return;
      const anchor = words.reduce((a, b) => (b.length > a.length ? b : a));
      // Buraco colado no começo/fim de um padrão curto ("Erro {0}") só aceita
      // valor curto (número, nome) — não uma frase de conteúdo da pessoa.
      const letters = key.replace(/\{\d+\}/g, '').replace(/[^A-Za-zÀ-ÿ]/g, '').length;
      const edges = [];
      if (letters < 12) {
        if (parts[0] === '' && parts.length > 1) edges.push(0);
        if (parts[parts.length - 1] === '' && parts.length > 1) edges.push(order.length - 1);
      }
      const entry = { re: new RegExp(re + '$'), order, v, litLen, edges };
      if (!byWord.has(anchor)) byWord.set(anchor, []);
      byWord.get(anchor).push(entry);
    }
    for (const list of byWord.values()) list.sort((a, b) => b.litLen - a.litLen);

    function fromPatterns(n, depth) {
      const words = n.match(WORD_RE);
      if (!words) return null;
      let cands = null;
      const seen = new Set();
      for (const w of words) {
        const lw = w.toLowerCase();
        if (seen.has(lw)) continue;
        seen.add(lw);
        const b = byWord.get(lw);
        if (b) cands = cands ? cands.concat(b) : b.slice();
      }
      if (!cands) return null;
      if (cands.length > 1) cands.sort((a, b) => b.litLen - a.litLen);
      for (const c of cands) {
        const m = c.re.exec(n);
        if (!m) continue;
        // (a não ser que o trecho capturado também seja texto conhecido da interface)
        if (c.edges.length && c.edges.some(g => { const cap = (m[g + 1] || '').trim(); return cap.split(/\s+/).length > 3 && !exact.has(norm(cap)); })) continue;
        return c.v.replace(/\{(\d+)\}/g, (_, i) => {
          const idx = c.order.indexOf(+i);
          const cap = idx >= 0 ? m[idx + 1] : '';
          if (!cap || depth > 1) return cap || '';
          const t = tx(cap, depth + 1);
          return t == null ? cap : t;
        });
      }
      return null;
    }
    // Texto (já normalizado ou não) → tradução, ou null se não houver.
    function tx(s, depth) {
      const n = norm(s);
      if (!n) return null;
      const hit = exact.get(n);
      if (hit !== undefined) return hit;
      if (cache.has(n)) return cache.get(n);
      let r = null;
      if (!outputs.has(n)) r = fromPatterns(n, depth || 0);
      // "3 ativos · 2 áreas": partes montadas com o separador · traduzidas uma a uma.
      if (r == null && (depth || 0) < 2 && n.indexOf(' · ') > 0) {
        let changed = false;
        const pieces = n.split(' · ').map(p => { const t = p ? tx(p, (depth || 0) + 1) : null; if (t != null) changed = true; return t == null ? p : t; });
        if (changed) r = pieces.join(' · ');
      }
      if (cache.size > 5000) cache.clear();
      cache.set(n, r);
      if (r != null) cache.set(norm(r), null);
      return r;
    }
    // T('Excluir "{0}"?', nome) ou T(`Excluir "${nome}"?`)
    function T(s, ...args) {
      if (s == null) return s;
      const str = String(s);
      if (args.length) {
        const k = exact.get(norm(str));
        const base = k !== undefined ? k : str;
        return base.replace(/\{(\d+)\}/g, (m, i) => (args[+i] !== undefined ? String(args[+i]) : m));
      }
      const r = tx(str);
      if (r == null) return str;
      const lead = str.match(/^\s*/)[0], trail = str.match(/\s*$/)[0];
      return lead + r + trail;
    }
    // Traduz um trecho de HTML (e-mails no servidor): textos entre tags e
    // atributos de interface.
    function html(src) {
      return String(src).replace(/(<(?:script|style)\b[\s\S]*?<\/(?:script|style)>)|(<[^>]+>)|([^<]+)/gi, (m, skip, tag, text) => {
        if (skip) return skip;
        if (tag) {
          return tag.replace(/(\s(?:title|alt|aria-label|placeholder)\s*=\s*")([^"]*)(")/gi, (mm, a, v, b) => {
            const r = tx(decodeEntities(v));
            return r == null ? mm : a + encodeAttr(r) + b;
          });
        }
        if (!/[A-Za-zÀ-ÿ]/.test(text)) return text;
        const r = tx(decodeEntities(text));
        if (r == null) return text;
        const lead = text.match(/^\s*/)[0], trail = text.match(/\s*$/)[0];
        return lead + encodeText(r) + trail;
      });
    }
    return { tx, T, html, has: (s) => exact.has(norm(s)), outputs };
  }
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', hellip: '…', mdash: '—', ndash: '–', rarr: '→' };
  function decodeEntities(s) {
    return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, g) => {
      if (g[0] === '#') return String.fromCodePoint(g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10));
      const v = ENT[g.toLowerCase()];
      return v !== undefined ? v : m;
    });
  }
  const encodeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const encodeAttr = (s) => encodeText(s).replace(/"/g, '&quot;');

  // Nome do país no idioma pedido (cai no código se o Intl não souber).
  function countryName(code, loc) {
    try { return new Intl.DisplayNames([loc || 'pt-BR'], { type: 'region' }).of(code) || code; } catch (e) { return code; }
  }
  const api = { LANGS, LOCALES, PT_COUNTRIES, COUNTRIES, validCountry, countryName, langForCountry, validLang, localeFor, createTranslator, norm };

  /* ── Node ── */
  if (typeof module !== 'undefined' && module.exports && typeof window === 'undefined') {
    module.exports = api;
    return;
  }

  /* ── Navegador ── */
  const w = root;
  const doc = w.document;
  const LS_KEY = 'rework-lang';
  const LS_LOCALE = 'rework-locale';
  const ls = {
    get(k) { try { return w.localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { v == null ? w.localStorage.removeItem(k) : w.localStorage.setItem(k, v); } catch (e) {} }
  };
  let qLang = null;
  try { qLang = validLang(new URLSearchParams(w.location.search).get('lang')); } catch (e) {}
  if (qLang) ls.set(LS_KEY, qLang);
  const navLang = (() => {
    const l = String((w.navigator && (w.navigator.languages && w.navigator.languages[0] || w.navigator.language)) || 'pt').toLowerCase();
    return l.indexOf('pt') === 0 ? 'pt' : 'en';
  })();
  // <script data-lang="pt"> fixa o idioma da página (ex.: o console).
  const forced = validLang(doc && doc.currentScript && doc.currentScript.getAttribute('data-lang'));
  const lang = forced || validLang(ls.get(LS_KEY)) || navLang;
  const locale = (lang === 'en' && ls.get(LS_LOCALE)) || LOCALES[lang];

  const I18N = Object.assign({}, api, {
    lang, locale, ready: lang === 'pt',
    // Português: só troca os {0}, {1}… pelos valores.
    T: (s, ...args) => (args.length && s != null ? String(s).replace(/\{(\d+)\}/g, (m, i) => (args[+i] !== undefined ? String(args[+i]) : m)) : s),
    tx: () => null,
    html: (h) => h,
    /* Guarda o idioma efetivo vindo do /api/me. Devolve true se ele mudou
       (quem chama recarrega a página para aplicar). */
    remember(nextLang, nextLocale) {
      const l = validLang(nextLang) || 'pt';
      if (forced) return false;
      ls.set(LS_KEY, l);
      ls.set(LS_LOCALE, l === 'en' ? (nextLocale || null) : null);
      // Sem localStorage (modo privado bloqueado) não recarrega: entraria em laço.
      return l !== lang && ls.get(LS_KEY) === l;
    },
    translate(node) { if (tr) translateTree(node); }
  });
  w.I18N = I18N;
  w.T = function () { return I18N.T.apply(null, arguments); };
  if (doc && doc.documentElement) doc.documentElement.setAttribute('lang', lang === 'pt' ? 'pt-BR' : locale);
  if (lang === 'pt') return;

  /* Carrega o dicionário de forma síncrona (este script roda no <head>). */
  const me = doc.currentScript;
  const ver = me && me.src ? (me.src.match(/[?&]v=([^&]+)/) || [])[1] : '';
  const dictUrl = '/i18n/' + lang + '.js' + (ver ? '?v=' + ver : '');

  let tr = null;
  const ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'data-tip', 'data-tooltip', 'data-rx-tip', 'data-ktip', 'data-title', 'data-label', 'data-placeholder', 'data-empty', 'label'];
  const PAGE_LINKS = lang === 'en' ? { '/privacidade': '/privacy', '/termos': '/terms' } : {};
  const SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, CODE: 1, TEMPLATE: 1 };
  const LETTER = /[A-Za-zÀ-ÿ]/;
  const noTranslate = (el) => !!(el.getAttribute && (el.getAttribute('translate') === 'no' || (el.classList && el.classList.contains('notranslate'))));
  const skipEl = (el) => !!(SKIP_TAGS[el.nodeName] || el.isContentEditable || noTranslate(el));
  const inSkipped = (el) => !!(el && el.closest && el.closest('script,style,noscript,textarea,code,[translate="no"],.notranslate,[contenteditable=""],[contenteditable="true"]'));
  // <textarea>: o conteúdo é da pessoa, mas o placeholder/title são da interface.
  // Idem para a raiz de um editor (contenteditable): o data-placeholder é da interface.
  const attrsOnly = (el) => (el.nodeName === 'TEXTAREA' || (el.hasAttribute && el.hasAttribute('contenteditable'))) && !noTranslate(el);

  // O que o próprio tradutor escreveu não é traduzido de novo ("Dados" → "Data"
  // não pode virar "Date" só porque "Data" também é uma chave em português).
  // Depuração: localStorage['rework-i18n-debug'] = '1' → I18N.missing() lista o
  // texto com cara de português que apareceu na tela sem tradução.
  const missing = ls.get('rework-i18n-debug') === '1' ? new Set() : null;
  const PT_HINT = /[ãõçáéíóúâêô]|\b(não|você|para|com|sem|uma|demandas?|etapa|equipe|prazo)\b/i;
  I18N.missing = () => (missing ? [...missing] : 'ative com localStorage.setItem("rework-i18n-debug", "1") e recarregue');
  const wroteText = new WeakMap();
  const wroteAttr = new WeakMap();
  function translateText(node) {
    const v = node.data;
    if (!v || !LETTER.test(v) || wroteText.get(node) === v) return;
    // Mesma palavra, sentidos diferentes ("Início" = Home ou Start): o elemento
    // pode trazer a tradução pronta em data-<idioma>.
    const own = node.parentElement && node.parentElement.getAttribute('data-' + lang);
    const r = own || tr.tx(v);
    if (r == null) { if (missing && PT_HINT.test(v)) missing.add(norm(v)); return; }
    const lead = v.match(/^\s*/)[0], trail = v.match(/\s*$/)[0];
    const out = lead + r + trail;
    if (out !== v) { wroteText.set(node, out); node.data = out; }
  }
  function setAttr(el, a, v) {
    const r = tr.tx(v);
    if (r == null || r === v) return;
    let m = wroteAttr.get(el); if (!m) { m = {}; wroteAttr.set(el, m); }
    m[a] = r;
    el.setAttribute(a, r);
  }
  const attrWritten = (el, a, v) => { const m = wroteAttr.get(el); return !!(m && m[a] === v); };
  function translateAttrs(el) {
    for (let i = 0; i < ATTRS.length; i++) {
      const a = ATTRS[i];
      const v = el.getAttribute(a);
      if (v && LETTER.test(v) && !attrWritten(el, a, v)) setAttr(el, a, v);
    }
    if (el.nodeName === 'INPUT' && (el.type === 'button' || el.type === 'submit' || el.type === 'reset') && el.value) {
      const r = tr.tx(el.value); if (r != null) el.value = r;
    }
    // Páginas com versão própria no idioma (termos, privacidade, manual…).
    if (el.nodeName === 'A') {
      const h = el.getAttribute('href');
      if (h && PAGE_LINKS[h]) el.setAttribute('href', PAGE_LINKS[h]);
    }
  }
  function translateTree(rootNode) {
    if (!rootNode) return;
    if (rootNode.nodeType === 3) { if (!inSkipped(rootNode.parentElement)) translateText(rootNode); return; }
    if (rootNode.nodeType !== 1 && rootNode.nodeType !== 9 && rootNode.nodeType !== 11) return;
    if (rootNode.nodeType === 1) {
      if (inSkipped(rootNode.parentElement)) return;
      if (skipEl(rootNode)) { if (attrsOnly(rootNode)) translateAttrs(rootNode); return; }
      translateAttrs(rootNode);
    }
    const walker = doc.createTreeWalker(rootNode, 5 /* ELEMENT | TEXT */, {
      acceptNode(n) {
        if (n.nodeType !== 1 || !skipEl(n)) return 1;
        if (attrsOnly(n)) translateAttrs(n);
        return 2; /* REJECT */
      }
    });
    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 3) translateText(n);
      else translateAttrs(n);
    }
  }
  function onMutations(muts) {
    for (let i = 0; i < muts.length; i++) {
      const m = muts[i];
      if (m.type === 'childList') {
        for (let j = 0; j < m.addedNodes.length; j++) translateTree(m.addedNodes[j]);
      } else if (m.type === 'characterData') {
        if (!inSkipped(m.target.parentElement)) translateText(m.target);
      } else if (m.type === 'attributes') {
        const el = m.target;
        const v = el.getAttribute(m.attributeName);
        if (v && LETTER.test(v) && !attrWritten(el, m.attributeName, v) && (attrsOnly(el) ? !inSkipped(el.parentElement) : !inSkipped(el))) setAttr(el, m.attributeName, v);
      }
    }
  }
  I18N.install = function (dict) {
    tr = createTranslator(dict || {});
    I18N.T = tr.T;
    I18N.tx = tr.tx;
    I18N.html = tr.html;
    I18N.ready = true;
    translateTree(doc);
    new MutationObserver(onMutations).observe(doc, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    // Diálogos nativos também passam pelo dicionário.
    const wrap = (fn) => function (msg) { const a = Array.prototype.slice.call(arguments); if (typeof msg === 'string') a[0] = tr.T(msg); return fn.apply(w, a); };
    w.alert = wrap(w.alert); w.confirm = wrap(w.confirm); w.prompt = wrap(w.prompt);
  };
  doc.write('<script src="' + dictUrl + '"><\/script>');
})(typeof window !== 'undefined' ? window : this);
