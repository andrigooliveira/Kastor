/* ─── MODELOS DE E-MAIL ───
   Todo o visual dos e-mails mora aqui: funções puras (dado → { subject, html,
   text }), sem acesso a banco nem envio. O server.js monta os dados e chama.

   Pré-visualização: /api/admin/email-preview (só admin). A página relê este
   arquivo a cada acesso, então dá pra editar o visual e só dar F5 — sem
   reiniciar o servidor. Os dados de exemplo ficam em previewSamples(), no fim.

   Visual segue o DESIGN.md (tema claro "papel" como base, roxo como sinal,
   hierarquia por tom e peso, labels 10px caixa-alta, bolinha da etapa).
   Regras de e-mail:
   - Estrutura em <table> e estilo inline: é o que Gmail e Outlook respeitam.
   - O <style> do <head> só ACRESCENTA (modo escuro no Apple Mail/iOS e
     ajuste de celular); o e-mail tem que ficar certo sem ele.
   - Nada de SVG, JS ou fonte web. Logo é PNG (/favicon.png). */

// Tokens do DESIGN.md — claro (base) e escuro (Apple Mail/iOS com tema escuro).
const T = {
  bg: '#f5f5f8', surface: '#ffffff', surface2: '#f5f5f8', surface3: '#e4e4ea',
  text: '#111114', media: '#4a4a55', baixa: '#6b6b74', hairline: '#ebebf0',
  roxo: '#7A00FF', roxoText: '#5E00CC', roxoDim: '#f2e6ff',
  sucesso: '#16a34a', aviso: '#b57100', avisoDim: '#fbf3e6', perigo: '#e7000b', perigoDim: '#fde6e7',
};
const D = {
  bg: '#0c0c10', surface: '#17171c', surface2: '#22222a', text: '#f5f5f7', media: '#b8b8b8',
  baixa: '#a1a1a1', hairline: '#26262d', roxoText: '#B380FF', roxoDim: '#2a1a42',
  aviso: '#f5a718', avisoDim: '#33280f', perigo: '#ff6467', perigoDim: '#3a1a1c',
};
const FONT = `'Geist',-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
const LABEL = 'font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase';
const NUM = 'font-variant-numeric:tabular-nums';

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const safeColor = c => (/^#[0-9a-f]{6}$/i.test(String(c || '')) ? c : T.roxo);
// Mistura `pct` da cor sobre `base` (equivalente ao color-mix do app, em hex).
function mix(hex, pct, base) {
  const p = n => [1, 3, 5].map(i => parseInt(n.slice(i, i + 2), 16));
  const a = p(safeColor(hex)), b = p(base);
  return '#' + a.map((v, i) => Math.round(v * pct + b[i] * (1 - pct)).toString(16).padStart(2, '0')).join('');
}
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const MESES_LONGOS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const EN_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const EN_MON_L = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const EN_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/* ── Idioma ──
   Os modelos são escritos em português. withLang(lang, tr, fn) monta um modelo
   em outro idioma (tr = tradutor do public/js/i18n.js, com o dicionário
   public/i18n/<lang>.js). t('Olá, {0}.', x) traduz a frase inteira e só depois
   encaixa os valores — que podem ser HTML (nome em negrito etc.). */
let _lang = 'pt', _tr = null;
function withLang(lang, tr, fn) {
  const prev = [_lang, _tr];
  _lang = lang || 'pt';
  _tr = _lang === 'pt' ? null : (tr || null);
  try { return fn(); } finally { [_lang, _tr] = prev; }
}
function t(s, ...args) {
  const hit = _tr ? _tr.tx(s) : null;
  const base = hit == null ? s : hit;
  return args.length ? base.replace(/\{(\d+)\}/g, (m, i) => (args[+i] !== undefined ? String(args[+i]) : m)) : base;
}
const fmtDue = ymd => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd || '');
  if (!m) return '';
  return _lang === 'en' ? `${EN_MON[Number(m[2]) - 1]} ${Number(m[3])}` : `${Number(m[3])} ${MESES[Number(m[2]) - 1]}`;
};
const firstName = n => String(n || '').trim().split(/\s+/)[0] || '';
const initials = n => String(n || '?').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();

/* ── Modo escuro ──
   Regras escritas uma vez e emitidas em dois lugares: dentro do
   @media (prefers-color-scheme: dark) — o que vale nos clientes de e-mail —
   e sob [data-rw-scheme=dark], que a pré-visualização usa pra forçar o tema. */
function schemeCss(extra = []) {
  const rules = [
    ['.rw-bg', `background:${D.bg}!important`],
    ['.rw-card', `background:${D.surface}!important`],
    ['.rw-sub', `background:${D.surface2}!important`],
    ['.rw-text', `color:${D.text}!important`],
    ['.rw-media', `color:${D.media}!important`],
    ['.rw-baixa', `color:${D.baixa}!important`],
    ['.rw-line', `border-color:${D.hairline}!important`],
    ['.rw-chip', `background:${D.roxoDim}!important;color:${D.roxoText}!important`],
    ['.rw-chip-aviso', `background:${D.avisoDim}!important;color:${D.aviso}!important`],
    ['.rw-chip-neutro', `background:${D.surface2}!important;color:${D.media}!important`],
    ['.rw-perigo', `color:${D.perigo}!important`],
    ['.rw-aviso', `color:${D.aviso}!important`],
    ...extra,
  ];
  const block = prefix => rules.map(([sel, decl]) => sel.split(',').map(s => prefix + s.trim()).join(',') + `{${decl}}`).join('\n');
  return `@media (prefers-color-scheme: dark){
${block(':root:not([data-rw-scheme=light]) ')}
}
${block('[data-rw-scheme=dark] ')}
@media (max-width:600px){
.rw-pad{padding:24px 20px!important}
.rw-outer{padding:20px 10px!important}
.rw-kpi-n{font-size:24px!important}
}`;
}

/* Moldura: logo, cartão e rodapé. `preheader` é a linha que aparece ao lado
   do assunto na caixa de entrada (fica escondida no corpo). */
function layout({ subject, preheader = '', content, footer, baseUrl, darkCss = [] }) {
  const logo = baseUrl
    ? `<img src="${escHtml(baseUrl)}/favicon.png" width="22" height="22" alt="" style="display:block;border:0;width:22px;height:22px">`
    : '';
  const prefs = baseUrl ? ` <a href="${escHtml(baseUrl)}/profile" class="rw-baixa" style="color:${T.baixa};text-decoration:underline">${t('Ajustar notificações')}</a>` : '';
  return `<!doctype html>
<html lang="${_lang === 'pt' ? 'pt-BR' : _lang}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escHtml(subject || 'reWork')}</title>
<style>
${schemeCss(darkCss)}
</style>
</head>
<body class="rw-bg" style="margin:0;padding:0;background:${T.bg};font-family:${FONT};-webkit-font-smoothing:antialiased">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escHtml(preheader)}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="rw-bg" style="background:${T.bg}">
<tr><td align="center" class="rw-outer" style="padding:32px 16px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px">
    <tr><td style="padding:0 4px 16px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        ${logo ? `<td style="padding-right:8px;vertical-align:middle">${logo}</td>` : ''}
        <td class="rw-text" style="vertical-align:middle;font-family:${FONT};font-size:16px;font-weight:700;letter-spacing:-0.02em;color:${T.text}">reWork</td>
      </tr></table>
    </td></tr>
    <tr><td class="rw-card rw-pad" style="background:${T.surface};border-radius:12px;padding:32px;font-family:${FONT}">
${content}
    </td></tr>
    <tr><td class="rw-baixa" style="padding:20px 8px 0;font-family:${FONT};font-size:12px;line-height:1.55;color:${T.baixa}">
      ${footer || t('Você recebe este e-mail porque tem uma conta no reWork.')}${prefs}
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;
}

// ── Peças ──
const chip = (text, tone = 'roxo') => {
  const c = { roxo: [T.roxoDim, T.roxoText, 'rw-chip'], aviso: [T.avisoDim, T.aviso, 'rw-chip-aviso'], neutro: [T.surface2, T.media, 'rw-chip-neutro'] }[tone];
  return `<span class="${c[2]}" style="display:inline-block;background:${c[0]};color:${c[1]};${LABEL};line-height:1;padding:5px 10px;border-radius:999px">${escHtml(text)}</span>`;
};
const headline = text =>
  `<h1 class="rw-text" style="margin:14px 0 0;font-family:${FONT};font-size:20px;line-height:1.3;font-weight:700;letter-spacing:-0.01em;color:${T.text}">${text}</h1>`;
const paragraph = (html, mt = 8) =>
  `<p class="rw-media" style="margin:${mt}px 0 0;font-size:14px;line-height:1.6;color:${T.media}">${html}</p>`;
const strong = t => `<strong class="rw-text" style="color:${T.text};font-weight:600">${escHtml(t)}</strong>`;
const button = (href, label) => href ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:28px"><tr>
  <td style="border-radius:6px;background:${T.roxo}">
    <a href="${escHtml(href)}" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:14px;font-weight:600;line-height:1;color:#ffffff;text-decoration:none;border-radius:6px">${escHtml(label)}</a>
  </td></tr></table>` : '';
// Nota pequena no rodapé do cartão (validade do link etc.).
const note = html => `<p class="rw-baixa" style="margin:24px 0 0;font-size:12px;line-height:1.6;color:${T.baixa}">${html}</p>`;
const linkLine = link => `<p class="rw-baixa" style="margin:12px 0 0;font-size:11px;line-height:1.5;color:${T.baixa};word-break:break-all">${escHtml(link)}</p>`;
const days = n => (n === 1 ? t('{0} dia', n) : t('{0} dias', n));

// Comentário: autor + texto com a marca roxa à esquerda (como no app).
function commentBlock(author, text, verb) {
  if (verb === undefined) verb = t('comentou');
  const body = escHtml(String(text || '').trim().slice(0, 600)).replace(/\n/g, '<br>');
  const head = author ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:10px"><tr>
      <td class="rw-chip" style="width:26px;height:26px;border-radius:999px;background:${T.roxoDim};color:${T.roxoText};font-size:10px;font-weight:700;text-align:center;vertical-align:middle">${escHtml(initials(author))}</td>
      <td class="rw-text" style="padding-left:8px;font-size:13px;font-weight:600;color:${T.text}">${escHtml(author)} <span class="rw-baixa" style="font-weight:400;color:${T.baixa}">${verb}</span></td>
    </tr></table>` : '';
  return `<div style="margin-top:20px">${head}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td class="rw-sub rw-text" style="background:${T.surface2};border-left:3px solid ${T.roxo};border-radius:0 10px 10px 0;padding:14px 16px;font-size:14px;line-height:1.6;color:${T.text}">${body}</td>
  </tr></table></div>`;
}

/* Cartão da demanda, inspirado no card de etapa do detalhe: fundo com um
   toque da cor da etapa, faixa de 3px à esquerda e a bolinha antes do nome. */
function demandCard({ demand, project, stage, due }) {
  const color = safeColor(stage && stage.color);
  const where = [project && project.client, project && project.name].filter(Boolean).map(escHtml).join(' · ');
  const stageLine = stage && stage.label
    ? `<span style="display:inline-block;width:8px;height:8px;border-radius:999px;background:${color};vertical-align:middle"></span><span class="rw-text" style="vertical-align:middle;padding-left:6px;font-size:13px;font-weight:600;color:${T.text}">${escHtml(stage.label)}</span>`
    : '';
  const dueLine = due ? `<span class="rw-baixa" style="vertical-align:middle;padding-left:${stageLine ? 12 : 0}px;font-size:13px;color:${T.baixa};${NUM}">${t('Prazo {0}', escHtml(fmtDue(due)))}</span>` : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px"><tr>
    <td class="rw-stagecard" style="background:${mix(color, 0.06, T.surface)};border:1px solid ${mix(color, 0.22, T.surface)};border-left:3px solid ${color};border-radius:10px;padding:16px 18px">
      <div class="rw-baixa" style="${LABEL};color:${T.baixa}">${t('Demanda')}</div>
      <div class="rw-text" style="margin-top:6px;font-size:15px;line-height:1.35;font-weight:600;letter-spacing:-0.005em;color:${T.text}">${escHtml(demand.name)}</div>
      ${where ? `<div class="rw-media" style="margin-top:2px;font-size:13px;line-height:1.5;color:${T.media}">${where}</div>` : ''}
      ${stageLine || dueLine ? `<div style="margin-top:12px">${stageLine}${dueLine}</div>` : ''}
    </td>
  </tr></table>`;
}
const stageCardDark = stage => {
  const c = safeColor(stage && stage.color);
  return [['.rw-stagecard', `background:${mix(c, 0.12, D.surface)}!important;border-color:${mix(c, 0.35, D.surface)}!important;border-left-color:${c}!important`]];
};

/* Notificações de demanda (atribuição, etapa, menção, observação, lembrete).
   ctx: { demand, project, trigger, stageName, stage:{label,color}, due,
          commentText, demandUrl, baseUrl } */
function notification(type, ctx) {
  const { demand, project, trigger, stageName, commentText, demandUrl, baseUrl, due } = ctx;
  const stage = ctx.stage || (stageName ? { label: stageName } : null);
  const who = trigger && trigger.name;
  let subject, tag, tone = 'roxo', title, lead = '', extra = '', preheader;
  switch (type) {
    case 'assigned':
      subject = t('[reWork] Você é o responsável: {0}', demand.name);
      tag = t('Responsável'); title = t('Você é o responsável por esta demanda');
      lead = who
        ? (stageName ? t('{0} passou a demanda pra você na etapa {1}.', strong(who), strong(stageName)) : t('{0} passou a demanda pra você.', strong(who)))
        : (stageName ? t('A demanda foi atribuída a você na etapa {0}.', strong(stageName)) : t('A demanda foi atribuída a você.'));
      preheader = `${demand.name}${stageName ? ' · ' + stageName : ''}`;
      break;
    case 'stage_assigned':
      subject = t('[reWork] Nova etapa para você: {0}', demand.name);
      tag = t('Nova etapa'); title = t('A etapa {0} é sua', escHtml(stageName || '—'));
      lead = t('A demanda avançou e agora está com você.');
      preheader = t('{0} chegou na etapa {1}', demand.name, stageName || '—');
      break;
    case 'mention':
      subject = t('[reWork] Mencionado em: {0}', demand.name);
      tag = t('Menção'); title = who ? t('{0} mencionou você', escHtml(who)) : t('Você foi mencionado');
      extra = commentBlock(who, commentText);
      preheader = String(commentText || '').slice(0, 120);
      break;
    case 'watch_stage':
      subject = t('[reWork] Etapa avançou (você observa): {0}', demand.name);
      tag = t('Observando'); tone = 'neutro'; title = t('Uma demanda que você observa avançou');
      lead = t('Agora está na etapa {0}.', strong(stageName || '—'));
      preheader = `${demand.name} → ${stageName || '—'}`;
      break;
    case 'watch_comment':
      subject = t('[reWork] Novo comentário (você observa): {0}', demand.name);
      tag = t('Observando'); tone = 'neutro'; title = t('Novo comentário numa demanda que você observa');
      extra = commentBlock(who, commentText);
      preheader = `${who ? who + ': ' : ''}${String(commentText || '').slice(0, 120)}`;
      break;
    case 'reminder':
      subject = t('[reWork] Lembrete: {0}', demand.name);
      tag = t('Lembrete'); tone = 'aviso'; title = t('Seu lembrete chegou');
      lead = t('Você pediu pra ser lembrado desta demanda.');
      extra = commentText ? commentBlock(t('Sua anotação'), commentText, '') : '';
      preheader = commentText ? String(commentText).slice(0, 120) : demand.name;
      break;
    default:
      return null;
  }
  const content = `${chip(tag, tone)}
${headline(title)}
${lead ? paragraph(lead) : ''}
${extra}
${demandCard({ demand, project, stage, due })}
${button(demandUrl, t('Abrir demanda'))}`;
  const html = layout({ subject, preheader, content, baseUrl, darkCss: stageCardDark(stage),
    footer: t('Você recebe este aviso porque ativou as notificações por e-mail no reWork.') });
  const plain = s => String(s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const text = [plain(title), lead && plain(lead), commentText && `"${String(commentText).slice(0, 600)}"`,
    `\n${t('Demanda: {0}', demand.name)}`,
    project && t('Projeto: {0}', [project.client, project.name].filter(Boolean).join(' · ')),
    stage && stage.label && t('Etapa: {0}', stage.label),
    demandUrl && `\n${t('Abrir: {0}', demandUrl)}`].filter(Boolean).join('\n');
  return { subject, html, text };
}

/* Resumo diário. Itens: { name, href, client, stageLabel, stageColor, due }.
   `unread`: { name, href, meta }. */
function digest({ firstName: fname, overdue, dueToday, dueSoon, unread, baseUrl, todayYmd, hour = 8, scheduleLabel }) {
  const tYmd = todayYmd || new Date().toISOString().slice(0, 10);
  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
  const dateLabel = (() => {
    const d = new Date(tYmd + 'T12:00:00');
    return _lang === 'en'
      ? `${EN_DAYS[d.getDay()]}, ${EN_MON_L[d.getMonth()]} ${d.getDate()}`
      : `${DIAS[d.getDay()]}, ${d.getDate()} de ${MESES_LONGOS[d.getMonth()]}`;
  })();

  const kpi = (n, label, tone) => {
    const color = n ? (tone === 'perigo' ? T.perigo : tone === 'aviso' ? T.aviso : T.text) : T.baixa;
    const cls = n ? (tone === 'perigo' ? 'rw-perigo' : tone === 'aviso' ? 'rw-aviso' : 'rw-text') : 'rw-baixa';
    return `<td class="rw-sub" width="33%" style="background:${T.surface2};border-radius:10px;padding:14px 16px;vertical-align:top">
      <div class="${cls} rw-kpi-n" style="font-size:28px;line-height:1;font-weight:700;letter-spacing:-0.02em;color:${color};${NUM}">${n}</div>
      <div class="rw-baixa" style="margin-top:8px;${LABEL};color:${T.baixa}">${label}</div>
    </td>`;
  };
  const gap = '<td width="8" style="width:8px;font-size:0;line-height:0">&nbsp;</td>';

  const row = (it, when, whenCls, whenColor, first) => {
    const color = safeColor(it.stageColor);
    const meta = [it.client, it.stageLabel].filter(Boolean).map(escHtml).join(' · ');
    const name = it.href
      ? `<a href="${escHtml(it.href)}" class="rw-text" style="color:${T.text};text-decoration:none">${escHtml(it.name)}</a>`
      : escHtml(it.name);
    const line = first ? '' : `border-top:1px solid ${T.hairline};`;
    return `<tr>
      <td class="rw-line" style="${line}padding:12px 0;vertical-align:top;width:16px">
        <span style="display:inline-block;width:8px;height:8px;border-radius:999px;background:${it.stageColor ? color : T.surface3};margin-top:6px"></span>
      </td>
      <td class="rw-line" style="${line}padding:12px 12px 12px 0;vertical-align:top">
        <div class="rw-text" style="font-size:14px;line-height:1.4;font-weight:600;color:${T.text}">${name}</div>
        ${meta ? `<div class="rw-baixa" style="margin-top:2px;font-size:12px;line-height:1.5;color:${T.baixa}">${meta}</div>` : ''}
      </td>
      <td class="rw-line ${whenCls}" align="right" style="${line}padding:12px 0;vertical-align:top;white-space:nowrap;font-size:12px;line-height:1.7;font-weight:600;color:${whenColor};${NUM}">${when}</td>
    </tr>`;
  };
  const section = (label, items, whenFn) => {
    if (!items.length) return '';
    const shown = items.slice(0, 10);
    return `<div class="rw-baixa" style="margin-top:28px;${LABEL};color:${T.baixa}">${label} · ${items.length}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:4px">
      ${shown.map((it, i) => { const [w, c, col] = whenFn(it); return row(it, w, c, col, i === 0); }).join('')}
    </table>
    ${items.length > shown.length ? `<div class="rw-baixa" style="margin-top:6px;font-size:12px;color:${T.baixa}">${t('…e mais {0}', items.length - shown.length)}</div>` : ''}`;
  };
  const late = it => { const n = daysBetween(it.due, tYmd); return [n === 1 ? t('há 1 dia') : t('há {0} dias', n), 'rw-perigo', T.perigo]; };
  const todayW = () => [t('hoje'), 'rw-aviso', T.aviso];
  const soon = it => { const n = daysBetween(tYmd, it.due); return [n === 1 ? t('amanhã') : fmtDue(it.due), 'rw-media', T.media]; };

  const total = overdue.length + dueToday.length + dueSoon.length;
  const intro = total
    ? t('Você tem {0} com prazo pedindo atenção.', strong(total === 1 ? t('1 demanda') : t('{0} demandas', total)))
    : t('Nenhum prazo apertado hoje. Só alguns avisos que ficaram pra trás.');
  const unreadBlock = unread.length ? `<div class="rw-baixa" style="margin-top:28px;${LABEL};color:${T.baixa}">${t('Notificações não lidas · {0}', unread.length)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:4px">
      ${unread.slice(0, 8).map((n, i) => row({ name: n.name, href: n.href, client: n.meta }, '', '', T.baixa, i === 0)).join('')}
    </table>` : '';

  const content = `<div class="rw-baixa" style="${LABEL};color:${T.baixa}">${escHtml(dateLabel)}</div>
<h1 class="rw-text" style="margin:8px 0 0;font-family:${FONT};font-size:28px;line-height:1.15;font-weight:700;letter-spacing:-0.02em;color:${T.text}">${greetingFor(hour)}, ${escHtml(fname)}</h1>
${paragraph(intro, 8)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px"><tr>
  ${kpi(overdue.length, t('Em atraso'), 'perigo')}${gap}${kpi(dueToday.length, t('Vencem hoje'), 'aviso')}${gap}${kpi(dueSoon.length, t('Próximos 3 dias'), 'neutro')}
</tr></table>
${section(t('Em atraso'), overdue, late)}
${section(t('Vencem hoje'), dueToday, todayW)}
${section(t('Próximos 3 dias'), dueSoon, soon)}
${unreadBlock}
${button(baseUrl, t('Abrir o reWork'))}`;
  const subject = t('[reWork] Resumo do dia — {0} pra hoje', overdue.length + dueToday.length);
  const preheader = [overdue.length && t('{0} em atraso', overdue.length), dueToday.length && t('{0} vencem hoje', dueToday.length), dueSoon.length && t('{0} nos próximos dias', dueSoon.length), unread.length && t('{0} não lidas', unread.length)].filter(Boolean).join(' · ');
  const html = layout({ subject, preheader, content, baseUrl, footer: t('Você recebe este resumo {0}. Dá pra mudar o horário no seu perfil.', scheduleLabel || t('nos dias úteis às 8h')) });
  return { subject, html };
}

const greetingFor = h => t(h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite');

/* Avisos segurados durante o modo Focado: um e-mail só, quando o foco acaba.
   items: [{ name, href, meta }] (meta = tipo do aviso + quem disparou). */
function heldSummary({ firstName: fname, items, baseUrl }) {
  const n = items.length;
  const shown = items.slice(0, 12);
  const rows = shown.map((it, i) => {
    const line = i === 0 ? '' : `border-top:1px solid ${T.hairline};`;
    const name = it.href
      ? `<a href="${escHtml(it.href)}" class="rw-text" style="color:${T.text};text-decoration:none">${escHtml(it.name)}</a>`
      : escHtml(it.name);
    return `<tr><td class="rw-line" style="${line}padding:12px 0;vertical-align:top">
      <div class="rw-text" style="font-size:14px;line-height:1.4;font-weight:600;color:${T.text}">${name}</div>
      ${it.meta ? `<div class="rw-baixa" style="margin-top:2px;font-size:12px;line-height:1.5;color:${T.baixa}">${escHtml(it.meta)}</div>` : ''}
    </td></tr>`;
  }).join('');
  const content = `${chip(t('Fim do foco'), 'roxo')}
${headline(n === 1 ? t('Chegou 1 aviso enquanto você estava focado') : t('Chegaram {0} avisos enquanto você estava focado', n))}
${paragraph(t('Seguramos tudo pra não te interromper, {0}. Aqui está o que ficou pra ver.', strong(fname)))}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px">${rows}</table>
${n > shown.length ? `<div class="rw-baixa" style="margin-top:6px;font-size:12px;color:${T.baixa}">${t('…e mais {0}', n - shown.length)}</div>` : ''}
${button(baseUrl, t('Abrir o reWork'))}`;
  const subject = n === 1 ? t('[reWork] 1 aviso enquanto você estava focado') : t('[reWork] {0} avisos enquanto você estava focado', n);
  const html = layout({ subject, preheader: shown.slice(0, 3).map(x => x.name).join(' · '), content, baseUrl, footer: t('Avisos segurados pelo status Focado.') });
  const text = `${t('Enquanto você estava focado:')}\n\n` + items.map(x => `- ${x.name}${x.meta ? ' (' + x.meta + ')' : ''}${x.href ? '\n  ' + x.href : ''}`).join('\n');
  return { subject, html, text };
}

function resetPassword({ name, link, baseUrl }) {
  const subject = t('[reWork] Redefinir sua senha');
  const content = `${chip(t('Conta'), 'neutro')}
${headline(t('Redefinir sua senha'))}
${paragraph(t('Olá, {0}. Recebemos um pedido pra redefinir a senha da sua conta. Toque no botão abaixo pra criar uma nova.', strong(firstName(name))))}
${button(link, t('Criar nova senha'))}
${note(t('O link vale por {0} e só pode ser usado uma vez. Se não foi você, ignore este e-mail — sua senha continua a mesma.', `<strong>${t('1 hora')}</strong>`))}
${linkLine(link)}`;
  const html = layout({ subject, preheader: t('O link vale por 1 hora.'), content, baseUrl, footer: t('Este e-mail foi enviado porque alguém pediu pra redefinir a senha desta conta.') });
  const text = `${t('Olá {0}, abra este link em 1h pra redefinir sua senha:', name)}\n\n${link}\n\n${t('Se não foi você, ignore.')}`;
  return { subject, html, text };
}

/* Confirmação de e-mail (vincular, confirmar o atual ou trocar). Vai pro
   endereço NOVO: só vale depois que a pessoa abre o link. */
function emailConfirm({ name, email, link, baseUrl, isChange }) {
  const subject = isChange ? t('[reWork] Confirme seu novo e-mail') : t('[reWork] Confirme seu e-mail');
  const content = `${chip(t('Conta'), 'neutro')}
${headline(isChange ? t('Confirme seu novo e-mail') : t('Confirme seu e-mail'))}
${paragraph(isChange
    ? t('Olá, {0}. Você pediu para trocar o e-mail da sua conta no reWork para {1}. Depois de confirmar, você também pode entrar com esse e-mail.', strong(firstName(name)), strong(email))
    : t('Olá, {0}. Falta só confirmar que {1} é seu para vincular à sua conta no reWork. Depois de confirmar, você também pode entrar com esse e-mail.', strong(firstName(name)), strong(email)))}
${button(link, t('Confirmar e-mail'))}
${note(t('O link vale por {0} e só pode ser usado uma vez. Se não foi você, ignore este e-mail: nada muda na conta.', `<strong>${t('24 horas')}</strong>`))}
${linkLine(link)}`;
  const html = layout({ subject, preheader: t('O link vale por 24 horas.'), content, baseUrl, footer: t('Este e-mail foi enviado porque alguém pediu para vincular este endereço a uma conta do reWork.') });
  const text = `${t('Olá {0}, abra este link em até 24h para confirmar {1} na sua conta do reWork:', name, email)}\n\n${link}\n\n${t('Se não foi você, ignore.')}`;
  return { subject, html, text };
}
/* Código de acesso (verificação em duas etapas por e-mail). */
function loginCode({ name, code, baseUrl, ip }) {
  const subject = t('[reWork] Seu código de acesso: {0}', code);
  const content = `${chip(t('Segurança'), 'neutro')}
${headline(t('Seu código de acesso'))}
${paragraph(t('Olá, {0}. Use este código para terminar de entrar no reWork:', strong(firstName(name))))}
<div class="rw-text" style="margin:22px 0 4px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:34px;font-weight:700;letter-spacing:.3em;color:${T.text}">${escHtml(code)}</div>
<p class="rw-baixa" style="margin:18px 0 0;font-size:12px;line-height:1.6;color:${T.baixa}">${ip
    ? t('O código vale por {0}. Pedido feito do endereço {1}. Se não foi você, alguém sabe a sua senha: troque-a no seu perfil.', `<strong>${t('10 minutos')}</strong>`, escHtml(ip))
    : t('O código vale por {0}. Se não foi você, alguém sabe a sua senha: troque-a no seu perfil.', `<strong>${t('10 minutos')}</strong>`)}</p>`;
  const html = layout({ subject, preheader: t('Código: {0} · vale 10 minutos.', code), content, baseUrl, footer: t('Você recebe este e-mail porque ativou a verificação em duas etapas.') });
  const text = `${t('Seu código de acesso ao reWork: {0}', code)}\n\n${t('Vale por 10 minutos. Se não foi você, troque a sua senha.')}`;
  return { subject, html, text };
}
/* Aviso: verificação em duas etapas ativada/desativada. */
function twoFactorNotice({ name, enabled, method, baseUrl }) {
  const how = method === 'totp' ? t('app autenticador') : t('código por e-mail');
  const subject = enabled ? t('[reWork] App autenticador ativado') : t('[reWork] App autenticador desativado');
  const content = `${chip(t('Segurança'), 'neutro')}
${headline(enabled ? t('App autenticador ativado') : t('App autenticador desativado'))}
${paragraph(enabled
    ? t('Olá, {0}. A partir de agora, entrar no reWork pede também o {1}.', strong(firstName(name)), strong(how))
    : t('Olá, {0}. O app autenticador foi desligado na sua conta. Entrar volta a pedir o código enviado para o seu e-mail.', strong(firstName(name))))}
${paragraph(t('Se não foi você, entre no reWork, troque a sua senha e fale com a coordenação da sua equipe.'))}
${button(baseUrl, t('Abrir o reWork'))}`;
  const html = layout({ subject, preheader: enabled ? t('Agora o login pede o {0}.', how) : t('O login voltou a pedir o código por e-mail.'), content, baseUrl, footer: t('Aviso de segurança da sua conta no reWork.') });
  const text = enabled ? t('O app autenticador foi ativado na sua conta do reWork.') : t('O app autenticador foi desativado na sua conta do reWork; o login volta a pedir o código por e-mail. Se não foi você, troque a senha.');
  return { subject, html, text };
}

/* Aviso pro endereço ANTIGO quando alguém pede a troca (segurança). */
function emailChangeNotice({ name, newEmail, baseUrl }) {
  const subject = t('[reWork] Pedido para trocar o e-mail da sua conta');
  const content = `${chip(t('Segurança'), 'neutro')}
${headline(t('Pedido para trocar o seu e-mail'))}
${paragraph(t('Olá, {0}. Alguém com a sua senha pediu para trocar o e-mail da sua conta no reWork para {1}. A troca só acontece quando o link enviado para o endereço novo for aberto.', strong(firstName(name)), strong(newEmail)))}
${paragraph(t('Se foi você, não precisa fazer nada. Se não foi, entre no reWork, cancele a troca no seu perfil e troque a sua senha.'))}
${button(baseUrl, t('Abrir o reWork'))}`;
  const html = layout({ subject, preheader: t('Troca para {0} aguardando confirmação.', newEmail), content, baseUrl, footer: t('Aviso de segurança da sua conta no reWork.') });
  const text = t('Olá {0}, pediram para trocar o e-mail da sua conta no reWork para {1}. Se não foi você, entre no reWork, cancele a troca no perfil e troque a senha.', name, newEmail);
  return { subject, html, text };
}

/* Convite pra entrar no reWork. `inviter` = quem convidou; `access` = rótulo
   do nível (Membro, Moderador…); `squads` = nomes das equipes liberadas. */
function invite({ name, inviter, org, access, squads, link, expiresAt, baseUrl, isOwner }) {
  const who = inviter || t('A equipe');
  if (isOwner) return ownerInvite({ name, org, link, expiresAt, baseUrl });
  const subject = org ? t('{0} convidou você para a {1} no reWork', who, org) : t('{0} convidou você para o reWork', who);
  const hello = name ? t('Olá, {0}.', strong(firstName(name))) : t('Olá!');
  const squadList = Array.isArray(squads) && squads.length ? squads : [];
  const details = [
    access ? t('Acesso: {0}', strong(t(access))) : '',
    squadList.length ? (squadList.length > 1 ? t('Equipes: {0}', squadList.map(n => strong(t(n))).join(', ')) : t('Equipe: {0}', strong(t(squadList[0])))) : ''
  ].filter(Boolean).join('<br>');
  const n = expiresAt ? Math.max(1, Math.round((Date.parse(expiresAt) - Date.now()) / 864e5)) : 7;
  const content = `${chip(t('Convite'), 'roxo')}
${headline(t('Você foi convidado para o reWork'))}
${paragraph(`${hello} ${org
    ? t('{0} chamou você para a equipe {1} no reWork, onde ficam as demandas, os prazos e as entregas do time.', strong(who), strong(org))
    : t('{0} chamou você para a equipe no reWork, onde ficam as demandas, os prazos e as entregas do time.', strong(who))}`)}
${details ? paragraph(details, 14) : ''}
${button(link, t('Aceitar convite'))}
${note(t('O convite vale por {0}. Você cria sua senha ao aceitar. Se não esperava este e-mail, pode ignorar.', `<strong>${days(n)}</strong>`))}
${linkLine(link)}`;
  const html = layout({ subject, preheader: t('{0} chamou você para a equipe.', who), content, baseUrl, footer: t('Este e-mail foi enviado porque alguém da equipe convidou este endereço para o reWork.') });
  const text = `${name ? t('Olá {0}!', name) : t('Olá!')} ${t('{0} convidou você para o reWork.', who)}\n\n${t('Aceite o convite e crie sua senha por este link (vale por {0}):', days(n))}\n\n${link}\n\n${t('Se não esperava este e-mail, pode ignorar.')}`;
  return { subject, html, text };
}

/* Lista de espera: confirmação pra quem pediu acesso. */
const TEAM_SIZE_LABEL = { '1-5': '1 a 5 pessoas', '6-15': '6 a 15 pessoas', '16-50': '16 a 50 pessoas', '51-200': '51 a 200 pessoas', '200+': 'Mais de 200 pessoas' };
function accessRequestReceived({ name, company, baseUrl }) {
  const subject = t('Recebemos seu pedido de acesso ao reWork');
  const content = `${chip(t('Lista de espera'), 'roxo')}
${headline(t('Seu pedido chegou'))}
${paragraph(t('Olá, {0}! Recebemos o pedido de acesso ao reWork para {1}.', strong(firstName(name)), strong(company)))}
${paragraph(t('Estamos abrindo o reWork aos poucos, para acompanhar de perto cada equipe que entra. Vamos analisar seu pedido e responder neste e-mail.'), 8)}`;
  const html = layout({ subject, preheader: t('Vamos analisar e responder neste e-mail.'), content, baseUrl, footer: t('Você recebeu este e-mail porque pediu acesso ao reWork.') });
  const text = t('Olá {0}! Recebemos o pedido de acesso ao reWork para {1}. Vamos analisar e responder neste e-mail.', name, company);
  return { subject, html, text };
}

/* Lista de espera: aviso pros superadmins do console. */
/* upsell = pedido de Enterprise de uma organização que já usa o reWork. */
function accessRequestNew({ request, consoleUrl, baseUrl, upsell }) {
  const r = request || {};
  const subject = upsell ? `[reWork Console] Pedido de Enterprise: ${r.company}` : `[reWork Console] Novo pedido de acesso: ${r.company}`;
  const rows = [
    ['Nome', r.name], ['E-mail', r.email], [upsell ? 'Organização' : 'Empresa', r.company],
    upsell ? ['Plano atual', r.currentPlan] : null,
    upsell ? ['Pessoas', r.people] : ['Equipe', TEAM_SIZE_LABEL[r.teamSize] || r.teamSize],
    ['Cargo', r.role], ['Telefone', r.phone], ['Site', r.website]
  ].filter(x => x && x[1]).map(([k, v]) => `${escHtml(k)}: ${strong(v)}`).join('<br>');
  const content = `${chip(upsell ? 'CRM · Enterprise' : 'Lista de espera', 'roxo')}
${headline(upsell ? 'Pedido de Enterprise' : 'Novo pedido de acesso')}
${paragraph(rows)}
${r.message ? paragraph(`“${escHtml(r.message)}”`, 14) : ''}
${button(consoleUrl, 'Abrir no console')}`;
  const html = layout({ subject, preheader: `${r.name} · ${r.company}`, content, baseUrl, footer: 'Aviso do reWork Console para superadmins da plataforma.' });
  const text = `${upsell ? 'Pedido de Enterprise' : 'Novo pedido de acesso ao reWork'}\n\n${r.name} <${r.email}>\n${r.company} · ${upsell ? `${r.people} pessoas · plano ${r.currentPlan || ''}` : TEAM_SIZE_LABEL[r.teamSize] || r.teamSize}\n\n${r.message || ''}\n\n${consoleUrl}`;
  return { subject, html, text };
}

/* Convite pra ser superadmin do console. */
function consoleAdminInvite({ name, inviter, link, baseUrl }) {
  const subject = 'Seu acesso ao reWork Console';
  const content = `${chip('Console', 'neutro')}
${headline('Você agora é superadmin')}
${paragraph(`Olá, ${strong(firstName(name))}. ${strong(inviter || 'Um superadmin')} deu a você acesso ao reWork Console, o painel da plataforma.`)}
${paragraph('Crie sua senha e cadastre um app autenticador (Google Authenticator, Authy, 1Password) — ele gera o código pedido em cada entrada.', 8)}
${button(link, 'Ativar meu acesso')}
<p class="rw-baixa" style="margin:24px 0 0;font-size:12px;line-height:1.6;color:${T.baixa}">O link vale por <strong>48 horas</strong> e só pode ser usado uma vez.</p>`;
  const html = layout({ subject, preheader: 'O link vale por 48 horas.', content, baseUrl, footer: 'Este e-mail foi enviado por um superadmin do reWork Console.' });
  const text = `Olá ${name}! ${inviter || 'Um superadmin'} deu a você acesso ao reWork Console. Ative em até 48h:\n\n${link}`;
  return { subject, html, text };
}

/* Console: redefinir a senha (o código do app continua sendo pedido). */
function consoleResetPassword({ name, link, baseUrl }) {
  const subject = '[reWork Console] Redefinir sua senha';
  const content = `${chip('Console', 'neutro')}
${headline('Redefinir a senha do console')}
${paragraph(`Olá, ${strong(firstName(name))}. Recebemos um pedido para redefinir a senha do seu acesso ao reWork Console.`)}
${button(link, 'Criar nova senha')}
<p class="rw-baixa" style="margin:24px 0 0;font-size:12px;line-height:1.6;color:${T.baixa}">O link vale por <strong>1 hora</strong>. Na próxima entrada o console continua pedindo o código do app autenticador. Se não foi você, ignore este e-mail.</p>`;
  const html = layout({ subject, preheader: 'O link vale por 1 hora.', content, baseUrl, footer: 'Aviso de segurança do reWork Console.' });
  const text = `Olá ${name}, redefina a senha do reWork Console em até 1h:\n\n${link}\n\nSe não foi você, ignore.`;
  return { subject, html, text };
}

/* Console: aviso aos outros superadmins de que houve recuperação pelo servidor. */
function consoleRecoveryNotice({ name, email, baseUrl }) {
  const subject = '[reWork Console] Acesso recuperado pelo servidor';
  const content = `${chip('Segurança', 'neutro')}
${headline('Um acesso foi recuperado pelo servidor')}
${paragraph(`O acesso de ${strong(name)} (${escHtml(email)}) ao reWork Console foi redefinido usando a recuperação pelo servidor (CONSOLE_RECOVERY_TOKEN).`)}
${paragraph('Se isso não era esperado, confira a Auditoria do console e troque o valor da variável no servidor.', 8)}`;
  const html = layout({ subject, preheader: `${name} teve o acesso redefinido.`, content, baseUrl, footer: 'Aviso de segurança do reWork Console.' });
  const text = `O acesso de ${name} (${email}) ao reWork Console foi redefinido pela recuperação do servidor. Se não era esperado, confira a Auditoria.`;
  return { subject, html, text };
}

/* Convite pro dono de uma organização nova (pedido aprovado na lista de espera). */
function ownerInvite({ name, org, link, expiresAt, baseUrl }) {
  const subject = org ? t('Sua organização {0} no reWork está pronta', org) : t('Sua organização no reWork está pronta');
  const n = expiresAt ? Math.max(1, Math.round((Date.parse(expiresAt) - Date.now()) / 864e5)) : 7;
  const hello = name ? t('Olá, {0}!', strong(firstName(name))) : t('Olá!');
  const content = `${chip(t('Acesso liberado'), 'roxo')}
${headline(t('Seu acesso ao reWork foi aprovado'))}
${paragraph(`${hello} ${org
    ? t('O pedido de acesso da {0} foi aprovado. A organização já está criada e você é o dono dela.', strong(org))
    : t('O pedido de acesso foi aprovado. A organização já está criada e você é o dono dela.')}`)}
${paragraph(t('Crie sua conta pelo botão abaixo. Depois é só convidar as pessoas, criar as equipes e cadastrar os clientes.'), 8)}
${button(link, t('Criar minha conta'))}
${note(t('O link vale por {0}. Se já tem conta no reWork, é só confirmar sua senha.', `<strong>${days(n)}</strong>`))}
${linkLine(link)}`;
  const html = layout({ subject, preheader: t('A organização já está criada. Falta só você.'), content, baseUrl, footer: t('Você recebeu este e-mail porque pediu acesso ao reWork.') });
  const text = `${name ? t('Olá {0}!', name) + ' ' : ''}${org ? t('O pedido de acesso da {0} ao reWork foi aprovado.', org) : t('O pedido de acesso ao reWork foi aprovado.')} ${t('Crie sua conta (link vale {0}):', days(n))}\n\n${link}`;
  return { subject, html, text };
}

function testEmail({ name, baseUrl }) {
  const subject = t('[reWork] Teste de notificação por e-mail');
  const content = `${chip(t('Tudo certo'), 'roxo')}
${headline(t('Seus e-mails estão chegando'))}
${paragraph(t('Olá, {0}! Este é um teste do canal de e-mails do reWork.', strong(firstName(name))))}
${paragraph(t('A partir de agora você recebe aqui os avisos de demandas, menções e o resumo do dia — conforme o que estiver ligado no seu perfil.'), 8)}`;
  const html = layout({ subject, preheader: t('Canal de e-mails funcionando.'), content, baseUrl });
  const text = t('Olá {0}! Este é um teste do canal de e-mails do reWork.', name);
  return { subject, html, text };
}

/* ── Dados de exemplo pra pré-visualização (/api/admin/email-preview) ──
   Mexa à vontade: nomes longos, comentários grandes, listas vazias… */
function previewSamples(baseUrl, me) {
  const url = baseUrl || 'https://rework.exemplo.com';
  const name = (me && me.name) || 'Andrigo Oliveira';
  const demand = { id: 'exemplo', name: 'LP Pré-Lançamento Gênova — ajustes da dobra de depoimentos' };
  const project = { name: 'Lançamento Gênova', client: 'BRZ Empreendimentos' };
  const trigger = { name: 'Carla Menezes' };
  const demandUrl = `${url}/demands/${demand.id}`;
  const comment = 'Oi! Subi a nova versão do KV com o ajuste de cor no botão. Consegue revisar até amanhã de manhã? Se estiver ok já mando pro cliente.';
  const ctx = { demand, project, trigger, demandUrl, baseUrl: url, due: '2026-09-25' };
  const st = (label, color) => ({ stageName: label, stage: { label, color } });
  const todayYmd = new Date().toISOString().slice(0, 10);
  const shift = n => new Date(Date.parse(todayYmd) + n * 864e5).toISOString().slice(0, 10);
  const item = (n, client, stageLabel, stageColor, due) => ({ name: n, href: demandUrl, client, stageLabel, stageColor, due });
  return [
    { key: 'assigned', label: 'Atribuído como responsável', build: () => notification('assigned', { ...ctx, ...st('Criação', '#7A00FF') }) },
    { key: 'stage_assigned', label: 'Nova etapa pra você', build: () => notification('stage_assigned', { ...ctx, ...st('Revisão de texto', '#f5a718') }) },
    { key: 'mention', label: 'Menção em comentário', build: () => notification('mention', { ...ctx, ...st('Criação', '#7A00FF'), commentText: '@' + name.split(' ')[0] + ' ' + comment }) },
    { key: 'watch_stage', label: 'Etapa avançou (observando)', build: () => notification('watch_stage', { ...ctx, ...st('Aprovação do cliente', '#16a34a') }) },
    { key: 'watch_comment', label: 'Novo comentário (observando)', build: () => notification('watch_comment', { ...ctx, ...st('Criação', '#7A00FF'), commentText: comment }) },
    { key: 'reminder', label: 'Lembrete com observação', build: () => notification('reminder', { ...ctx, ...st('Veiculação', '#e7000b'), trigger: null, commentText: 'Cobrar retorno do cliente sobre a dobra de depoimentos' }) },
    { key: 'reminder_plain', label: 'Lembrete sem observação', build: () => notification('reminder', { ...ctx, ...st('Veiculação', '#e7000b'), trigger: null, due: null }) },
    { key: 'digest', label: 'Resumo diário', build: () => ({ ...digest({
      firstName: name.split(' ')[0], baseUrl: url, todayYmd,
      overdue: [item('KV Black Friday — variações pra redes', 'BRZ', 'Criação', '#7A00FF', shift(-4)), item('Newsletter setembro', 'Hapvida', 'Revisão', '#f5a718', shift(-1))],
      dueToday: [item(demand.name, 'BRZ', 'Aprovação do cliente', '#16a34a', todayYmd)],
      dueSoon: [item('Disparo de WhatsApp — pré-lançamento', 'Gênova', 'Direcionamento', '#2b7fff', shift(1)), item('Post institucional outubro', 'Hapvida', 'Criação', '#7A00FF', shift(3))],
      unread: [{ name: 'Disparo de WhatsApp pré-lançamento', href: demandUrl, meta: 'Menção' }, { name: 'Novos criativos — campanha institucional', href: demandUrl, meta: 'Novo comentário' }],
    }), text: '' }) },
    { key: 'digest_empty', label: 'Resumo diário (só notificações)', build: () => ({ ...digest({
      firstName: name.split(' ')[0], baseUrl: url, todayYmd, overdue: [], dueToday: [], dueSoon: [],
      unread: [{ name: 'Newsletter setembro', href: demandUrl, meta: 'Etapa avançou' }],
    }), text: '' }) },
    { key: 'held', label: 'Avisos segurados (fim do foco)', build: () => heldSummary({
      firstName: name.split(' ')[0], baseUrl: url,
      items: [
        { name: demand.name, href: demandUrl, meta: 'Menção · Carla Menezes' },
        { name: 'Newsletter setembro', href: demandUrl, meta: 'Nova etapa pra você · Revisão' },
        { name: 'KV Black Friday — variações pra redes', href: demandUrl, meta: 'Novo comentário · Rafa Souza' },
      ],
    }) },
    { key: 'reset', label: 'Redefinir senha', build: () => resetPassword({ name, link: `${url}/reset/exemplo-de-token-0000`, baseUrl: url }) },
    { key: 'login_code', label: 'Código de acesso (2 etapas)', build: () => loginCode({ name, code: '482913', baseUrl: url, ip: '189.40.12.7' }) },
    { key: 'twofa_on', label: 'Verificação em duas etapas ativada', build: () => twoFactorNotice({ name, enabled: true, method: 'totp', baseUrl: url }) },
    { key: 'email_confirm', label: 'Confirmar e-mail', build: () => emailConfirm({ name, email: 'andrigo@exemplo.com', link: `${url}/confirmar-email/exemplo-de-token-0000`, baseUrl: url }) },
    { key: 'email_change', label: 'Confirmar e-mail novo (troca)', build: () => emailConfirm({ name, email: 'novo@exemplo.com', link: `${url}/confirmar-email/exemplo-de-token-0000`, baseUrl: url, isChange: true }) },
    { key: 'email_change_notice', label: 'Aviso de troca de e-mail (endereço antigo)', build: () => emailChangeNotice({ name, newEmail: 'novo@exemplo.com', baseUrl: url }) },
    { key: 'invite', label: 'Convite para a equipe', build: () => invite({ name: 'Carla Menezes', inviter: name, access: 'Membro', squads: ['Imob', 'Performance'], link: `${url}/convite/exemplo-de-token-0000`, expiresAt: new Date(Date.now() + 7 * 864e5).toISOString(), baseUrl: url }) },
    { key: 'access_received', label: 'Lista de espera: pedido recebido', build: () => accessRequestReceived({ name: 'Paula Reis', company: 'Agência Norte', baseUrl: url }) },
    { key: 'access_new', label: 'Lista de espera: aviso ao console', build: () => accessRequestNew({ request: { name: 'Paula Reis', email: 'paula@agencianorte.com', company: 'Agência Norte', teamSize: '6-15', role: 'Diretora de operações', message: 'Hoje controlamos tudo em planilha e queremos organizar as demandas por cliente.' }, consoleUrl: `${url}/console/lista-de-espera`, baseUrl: url }) },
    { key: 'console_invite', label: 'Convite de superadmin', build: () => consoleAdminInvite({ name: 'Vinicius Ricarte', inviter: name, link: `${url}/console/ativar/exemplo-0000`, baseUrl: url }) },
    { key: 'console_reset', label: 'Console: redefinir senha', build: () => consoleResetPassword({ name, link: `${url}/console/redefinir/exemplo-0000`, baseUrl: url }) },
    { key: 'console_recovery', label: 'Console: recuperação pelo servidor', build: () => consoleRecoveryNotice({ name: 'Vinicius Ricarte', email: 'vinicius@exemplo.com', baseUrl: url }) },
    { key: 'test', label: 'Teste de e-mail (perfil)', build: () => testEmail({ name, baseUrl: url }) },
  ];
}

/* Suporte: chamado novo / resposta do cliente → superadmins. */
function supportToStaff({ ticket, message, kind, link, baseUrl, categoryLabel }) {
  const t = ticket || {}, m = message || {};
  const what = kind === 'new' ? 'Chamado novo' : kind === 'reopened' ? 'Chamado reaberto' : 'Nova resposta do cliente';
  const subject = `[Suporte #${t.number}] ${kind === 'new' ? '' : 'Re: '}${t.subject}`;
  const who = [['De', `${t.userName} (@${t.username})`], ['E-mail', t.email || '—'], ['Organização', t.orgName], ['Assunto', categoryLabel]]
    .map(([k, v]) => `${escHtml(k)}: ${strong(v)}`).join('<br>');
  const files = (m.files || []).length ? paragraph(`${(m.files || []).length} ${(m.files || []).length === 1 ? 'anexo' : 'anexos'} no console.`, 10) : '';
  const content = `${chip(`${what} · #${t.number}`, kind === 'new' ? 'roxo' : 'aviso')}
${headline(escHtml(t.subject))}
${paragraph(who, 12)}
${paragraph(escHtml(m.body || '').replace(/\n/g, '<br>'), 16)}
${files}
${button(link, 'Responder no console')}`;
  const html = layout({ subject, preheader: `${t.userName} · ${t.orgName}`, content, baseUrl, footer: 'Aviso do reWork Console para superadmins da plataforma.' });
  const text = `${what} #${t.number}: ${t.subject}\n\nDe: ${t.userName} (@${t.username}) <${t.email || '—'}>\nOrganização: ${t.orgName}\nAssunto: ${categoryLabel}\n\n${m.body || ''}\n\nResponder: ${link}`;
  return { subject, html, text };
}

/* Suporte: resposta da equipe → quem abriu o chamado. */
function supportToCustomer({ ticket, message, link, baseUrl }) {
  const tk = ticket || {}, m = message || {};
  const closed = tk.status === 'closed';
  const subject = t('[reWork] Resposta ao chamado #{0}: {1}', tk.number, tk.subject);
  const content = `${chip(t('Suporte · #{0}', tk.number), 'roxo')}
${headline(closed ? t('Seu chamado foi respondido e resolvido') : t('Respondemos seu chamado'))}
${paragraph(t('Olá, {0}. A equipe do reWork respondeu {1}:', strong(firstName(tk.userName)), strong(tk.subject)), 10)}
${paragraph(escHtml(m.body || '').replace(/\n/g, '<br>'), 14)}
${button(link, closed ? t('Ver o chamado') : t('Responder'))}`;
  const html = layout({ subject, preheader: String(m.body || '').slice(0, 90), content, baseUrl, footer: t('Você recebeu este e-mail porque abriu um chamado no suporte do reWork.') });
  const text = `${t('Olá {0}! A equipe do reWork respondeu seu chamado #{1} ({2}):', firstName(tk.userName), tk.number, tk.subject)}\n\n${m.body || ''}\n\n${link}`;
  return { subject, html, text };
}

module.exports = { withLang, supportToStaff, supportToCustomer, escHtml, layout, notification, digest, heldSummary, resetPassword, emailConfirm, emailChangeNotice, loginCode, twoFactorNotice, invite, accessRequestReceived, accessRequestNew, consoleAdminInvite, consoleResetPassword, consoleRecoveryNotice, testEmail, previewSamples };
