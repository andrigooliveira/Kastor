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
const fmtDue = ymd => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd || ''); return m ? `${Number(m[3])} ${MESES[Number(m[2]) - 1]}` : ''; };
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
  const prefs = baseUrl ? ` <a href="${escHtml(baseUrl)}/profile" class="rw-baixa" style="color:${T.baixa};text-decoration:underline">Ajustar notificações</a>` : '';
  return `<!doctype html>
<html lang="pt-BR"><head>
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
      ${footer || 'Você recebe este e-mail porque tem uma conta no reWork.'}${prefs}
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

// Comentário: autor + texto com a marca roxa à esquerda (como no app).
function commentBlock(author, text, verb = 'comentou') {
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
  const dueLine = due ? `<span class="rw-baixa" style="vertical-align:middle;padding-left:${stageLine ? 12 : 0}px;font-size:13px;color:${T.baixa};${NUM}">Prazo ${escHtml(fmtDue(due))}</span>` : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px"><tr>
    <td class="rw-stagecard" style="background:${mix(color, 0.06, T.surface)};border:1px solid ${mix(color, 0.22, T.surface)};border-left:3px solid ${color};border-radius:10px;padding:16px 18px">
      <div class="rw-baixa" style="${LABEL};color:${T.baixa}">Demanda</div>
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
      subject = `[reWork] Você é o responsável: ${demand.name}`;
      tag = 'Responsável'; title = 'Você é o responsável por esta demanda';
      lead = who ? `${strong(who)} passou a demanda pra você${stageName ? ` na etapa ${strong(stageName)}` : ''}.` : `A demanda foi atribuída a você${stageName ? ` na etapa ${strong(stageName)}` : ''}.`;
      preheader = `${demand.name}${stageName ? ' · ' + stageName : ''}`;
      break;
    case 'stage_assigned':
      subject = `[reWork] Nova etapa para você: ${demand.name}`;
      tag = 'Nova etapa'; title = `A etapa ${escHtml(stageName || '—')} é sua`;
      lead = `A demanda avançou e agora está com você.`;
      preheader = `${demand.name} chegou na etapa ${stageName || '—'}`;
      break;
    case 'mention':
      subject = `[reWork] Mencionado em: ${demand.name}`;
      tag = 'Menção'; title = who ? `${escHtml(who)} mencionou você` : 'Você foi mencionado';
      extra = commentBlock(who, commentText);
      preheader = String(commentText || '').slice(0, 120);
      break;
    case 'watch_stage':
      subject = `[reWork] Etapa avançou (você observa): ${demand.name}`;
      tag = 'Observando'; tone = 'neutro'; title = 'Uma demanda que você observa avançou';
      lead = `Agora está na etapa ${strong(stageName || '—')}.`;
      preheader = `${demand.name} → ${stageName || '—'}`;
      break;
    case 'watch_comment':
      subject = `[reWork] Novo comentário (você observa): ${demand.name}`;
      tag = 'Observando'; tone = 'neutro'; title = 'Novo comentário numa demanda que você observa';
      extra = commentBlock(who, commentText);
      preheader = `${who ? who + ': ' : ''}${String(commentText || '').slice(0, 120)}`;
      break;
    case 'reminder':
      subject = `[reWork] Lembrete: ${demand.name}`;
      tag = 'Lembrete'; tone = 'aviso'; title = 'Seu lembrete chegou';
      lead = 'Você pediu pra ser lembrado desta demanda.';
      extra = commentText ? commentBlock('Sua anotação', commentText, '') : '';
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
${button(demandUrl, 'Abrir demanda')}`;
  const html = layout({ subject, preheader, content, baseUrl, darkCss: stageCardDark(stage),
    footer: 'Você recebe este aviso porque ativou as notificações por e-mail no reWork.' });
  const plain = s => String(s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const text = [plain(title), lead && plain(lead), commentText && `"${String(commentText).slice(0, 600)}"`,
    `\nDemanda: ${demand.name}`,
    project && `Projeto: ${[project.client, project.name].filter(Boolean).join(' · ')}`,
    stage && stage.label && `Etapa: ${stage.label}`,
    demandUrl && `\nAbrir: ${demandUrl}`].filter(Boolean).join('\n');
  return { subject, html, text };
}

/* Resumo diário. Itens: { name, href, client, stageLabel, stageColor, due }.
   `unread`: { name, href, meta }. */
function digest({ firstName: fname, overdue, dueToday, dueSoon, unread, baseUrl, todayYmd, hour = 8, scheduleLabel }) {
  const tYmd = todayYmd || new Date().toISOString().slice(0, 10);
  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
  const dateLabel = (() => { const d = new Date(tYmd + 'T12:00:00'); return `${DIAS[d.getDay()]}, ${d.getDate()} de ${MESES_LONGOS[d.getMonth()]}`; })();

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
    ${items.length > shown.length ? `<div class="rw-baixa" style="margin-top:6px;font-size:12px;color:${T.baixa}">…e mais ${items.length - shown.length}</div>` : ''}`;
  };
  const late = it => { const n = daysBetween(it.due, tYmd); return [n === 1 ? 'há 1 dia' : `há ${n} dias`, 'rw-perigo', T.perigo]; };
  const todayW = () => ['hoje', 'rw-aviso', T.aviso];
  const soon = it => { const n = daysBetween(tYmd, it.due); return [n === 1 ? 'amanhã' : fmtDue(it.due), 'rw-media', T.media]; };

  const total = overdue.length + dueToday.length + dueSoon.length;
  const intro = total
    ? `Você tem ${strong(total === 1 ? '1 demanda' : `${total} demandas`)} com prazo pedindo atenção.`
    : 'Nenhum prazo apertado hoje. Só alguns avisos que ficaram pra trás.';
  const unreadBlock = unread.length ? `<div class="rw-baixa" style="margin-top:28px;${LABEL};color:${T.baixa}">Notificações não lidas · ${unread.length}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:4px">
      ${unread.slice(0, 8).map((n, i) => row({ name: n.name, href: n.href, client: n.meta }, '', '', T.baixa, i === 0)).join('')}
    </table>` : '';

  const content = `<div class="rw-baixa" style="${LABEL};color:${T.baixa}">${escHtml(dateLabel)}</div>
<h1 class="rw-text" style="margin:8px 0 0;font-family:${FONT};font-size:28px;line-height:1.15;font-weight:700;letter-spacing:-0.02em;color:${T.text}">${greetingFor(hour)}, ${escHtml(fname)}</h1>
${paragraph(intro, 8)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px"><tr>
  ${kpi(overdue.length, 'Em atraso', 'perigo')}${gap}${kpi(dueToday.length, 'Vencem hoje', 'aviso')}${gap}${kpi(dueSoon.length, 'Próximos 3 dias', 'neutro')}
</tr></table>
${section('Em atraso', overdue, late)}
${section('Vencem hoje', dueToday, todayW)}
${section('Próximos 3 dias', dueSoon, soon)}
${unreadBlock}
${button(baseUrl, 'Abrir o reWork')}`;
  const subject = `[reWork] Resumo do dia — ${overdue.length + dueToday.length} pra hoje`;
  const preheader = [overdue.length && `${overdue.length} em atraso`, dueToday.length && `${dueToday.length} vencem hoje`, dueSoon.length && `${dueSoon.length} nos próximos dias`, unread.length && `${unread.length} não lidas`].filter(Boolean).join(' · ');
  const html = layout({ subject, preheader, content, baseUrl, footer: `Você recebe este resumo ${scheduleLabel || 'nos dias úteis às 8h'}. Dá pra mudar o horário no seu perfil.` });
  return { subject, html };
}

const greetingFor = h => (h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite');

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
  const content = `${chip('Fim do foco', 'roxo')}
${headline(n === 1 ? 'Chegou 1 aviso enquanto você estava focado' : `Chegaram ${n} avisos enquanto você estava focado`)}
${paragraph(`Seguramos tudo pra não te interromper, ${strong(fname)}. Aqui está o que ficou pra ver.`)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px">${rows}</table>
${n > shown.length ? `<div class="rw-baixa" style="margin-top:6px;font-size:12px;color:${T.baixa}">…e mais ${n - shown.length}</div>` : ''}
${button(baseUrl, 'Abrir o reWork')}`;
  const subject = `[reWork] ${n === 1 ? '1 aviso' : `${n} avisos`} enquanto você estava focado`;
  const html = layout({ subject, preheader: shown.slice(0, 3).map(x => x.name).join(' · '), content, baseUrl, footer: 'Avisos segurados pelo status Focado.' });
  const text = `Enquanto você estava focado:\n\n` + items.map(x => `- ${x.name}${x.meta ? ' (' + x.meta + ')' : ''}${x.href ? '\n  ' + x.href : ''}`).join('\n');
  return { subject, html, text };
}

function resetPassword({ name, link, baseUrl }) {
  const subject = '[reWork] Redefinir sua senha';
  const content = `${chip('Conta', 'neutro')}
${headline('Redefinir sua senha')}
${paragraph(`Olá, ${strong(firstName(name))}. Recebemos um pedido pra redefinir a senha da sua conta. Toque no botão abaixo pra criar uma nova.`)}
${button(link, 'Criar nova senha')}
<p class="rw-baixa" style="margin:24px 0 0;font-size:12px;line-height:1.6;color:${T.baixa}">O link vale por <strong>1 hora</strong> e só pode ser usado uma vez. Se não foi você, ignore este e-mail — sua senha continua a mesma.</p>
<p class="rw-baixa" style="margin:12px 0 0;font-size:11px;line-height:1.5;color:${T.baixa};word-break:break-all">${escHtml(link)}</p>`;
  const html = layout({ subject, preheader: 'O link vale por 1 hora.', content, baseUrl, footer: 'Este e-mail foi enviado porque alguém pediu pra redefinir a senha desta conta.' });
  const text = `Olá ${name}, abra este link em 1h pra redefinir sua senha:\n\n${link}\n\nSe não foi você, ignore.`;
  return { subject, html, text };
}

/* Convite pra entrar no reWork. `inviter` = quem convidou; `access` = rótulo
   do nível (Equipe, Moderador…); `squads` = nomes dos squads liberados. */
function invite({ name, inviter, org, access, squads, link, expiresAt, baseUrl, isOwner }) {
  const who = inviter || 'A equipe';
  if (isOwner) return ownerInvite({ name, org, link, expiresAt, baseUrl });
  const subject = org ? `${who} convidou você para a ${org} no reWork` : `${who} convidou você para o reWork`;
  const hello = name ? `Olá, ${strong(firstName(name))}. ` : 'Olá! ';
  const squadList = Array.isArray(squads) && squads.length ? squads : [];
  const details = [
    access ? `Acesso: ${strong(access)}` : '',
    squadList.length ? `${squadList.length > 1 ? 'Squads' : 'Squad'}: ${squadList.map(n => strong(n)).join(', ')}` : ''
  ].filter(Boolean).join('<br>');
  const days = expiresAt ? Math.max(1, Math.round((Date.parse(expiresAt) - Date.now()) / 864e5)) : 7;
  const content = `${chip('Convite', 'roxo')}
${headline('Você foi convidado para o reWork')}
${paragraph(`${hello}${strong(who)} chamou você para a equipe${org ? ` ${strong(org)}` : ''} no reWork, onde ficam as demandas, os prazos e as entregas do time.`)}
${details ? paragraph(details, 14) : ''}
${button(link, 'Aceitar convite')}
<p class="rw-baixa" style="margin:24px 0 0;font-size:12px;line-height:1.6;color:${T.baixa}">O convite vale por <strong>${days} ${days === 1 ? 'dia' : 'dias'}</strong>. Você cria sua senha ao aceitar. Se não esperava este e-mail, pode ignorar.</p>
<p class="rw-baixa" style="margin:12px 0 0;font-size:11px;line-height:1.5;color:${T.baixa};word-break:break-all">${escHtml(link)}</p>`;
  const html = layout({ subject, preheader: `${who} chamou você para a equipe.`, content, baseUrl, footer: 'Este e-mail foi enviado porque alguém da equipe convidou este endereço para o reWork.' });
  const text = `${name ? `Olá ${name}! ` : 'Olá! '}${who} convidou você para o reWork.\n\nAceite o convite e crie sua senha por este link (vale por ${days} dias):\n\n${link}\n\nSe não esperava este e-mail, pode ignorar.`;
  return { subject, html, text };
}

/* Lista de espera: confirmação pra quem pediu acesso. */
const TEAM_SIZE_LABEL = { '1-5': '1 a 5 pessoas', '6-15': '6 a 15 pessoas', '16-50': '16 a 50 pessoas', '51-200': '51 a 200 pessoas', '200+': 'Mais de 200 pessoas' };
function accessRequestReceived({ name, company, baseUrl }) {
  const subject = 'Recebemos seu pedido de acesso ao reWork';
  const content = `${chip('Lista de espera', 'roxo')}
${headline('Seu pedido chegou')}
${paragraph(`Olá, ${strong(firstName(name))}! Recebemos o pedido de acesso ao reWork para ${strong(company)}.`)}
${paragraph('Estamos abrindo o reWork aos poucos, para acompanhar de perto cada equipe que entra. Vamos analisar seu pedido e responder neste e-mail.', 8)}`;
  const html = layout({ subject, preheader: 'Vamos analisar e responder neste e-mail.', content, baseUrl, footer: 'Você recebeu este e-mail porque pediu acesso ao reWork.' });
  const text = `Olá ${name}! Recebemos o pedido de acesso ao reWork para ${company}. Vamos analisar e responder neste e-mail.`;
  return { subject, html, text };
}

/* Lista de espera: aviso pros superadmins do console. */
function accessRequestNew({ request, consoleUrl, baseUrl }) {
  const r = request || {};
  const subject = `[reWork Console] Novo pedido de acesso: ${r.company}`;
  const rows = [
    ['Nome', r.name], ['E-mail', r.email], ['Empresa', r.company],
    ['Equipe', TEAM_SIZE_LABEL[r.teamSize] || r.teamSize], ['Cargo', r.role], ['Telefone', r.phone], ['Site', r.website]
  ].filter(([, v]) => v).map(([k, v]) => `${escHtml(k)}: ${strong(v)}`).join('<br>');
  const content = `${chip('Lista de espera', 'roxo')}
${headline('Novo pedido de acesso')}
${paragraph(rows)}
${r.message ? paragraph(`“${escHtml(r.message)}”`, 14) : ''}
${button(consoleUrl, 'Abrir no console')}`;
  const html = layout({ subject, preheader: `${r.name} · ${r.company}`, content, baseUrl, footer: 'Aviso do reWork Console para superadmins da plataforma.' });
  const text = `Novo pedido de acesso ao reWork\n\n${r.name} <${r.email}>\n${r.company} · ${TEAM_SIZE_LABEL[r.teamSize] || r.teamSize}\n\n${r.message || ''}\n\n${consoleUrl}`;
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
  const subject = `Sua organização ${org || ''} no reWork está pronta`.replace(/\s+/g, ' ');
  const days = expiresAt ? Math.max(1, Math.round((Date.parse(expiresAt) - Date.now()) / 864e5)) : 7;
  const content = `${chip('Acesso liberado', 'roxo')}
${headline('Seu acesso ao reWork foi aprovado')}
${paragraph(`${name ? `Olá, ${strong(firstName(name))}! ` : 'Olá! '}O pedido de acesso${org ? ` da ${strong(org)}` : ''} foi aprovado. A organização já está criada e você é o dono dela.`)}
${paragraph('Crie sua conta pelo botão abaixo. Depois é só convidar a equipe, criar os squads e cadastrar os clientes.', 8)}
${button(link, 'Criar minha conta')}
<p class="rw-baixa" style="margin:24px 0 0;font-size:12px;line-height:1.6;color:${T.baixa}">O link vale por <strong>${days} ${days === 1 ? 'dia' : 'dias'}</strong>. Se já tem conta no reWork, é só confirmar sua senha.</p>
<p class="rw-baixa" style="margin:12px 0 0;font-size:11px;line-height:1.5;color:${T.baixa};word-break:break-all">${escHtml(link)}</p>`;
  const html = layout({ subject, preheader: 'A organização já está criada. Falta só você.', content, baseUrl, footer: 'Você recebeu este e-mail porque pediu acesso ao reWork.' });
  const text = `${name ? `Olá ${name}! ` : ''}O pedido de acesso${org ? ` da ${org}` : ''} ao reWork foi aprovado. Crie sua conta (link vale ${days} dias):\n\n${link}`;
  return { subject, html, text };
}

function testEmail({ name, baseUrl }) {
  const subject = '[reWork] Teste de notificação por e-mail';
  const content = `${chip('Tudo certo', 'roxo')}
${headline('Seus e-mails estão chegando')}
${paragraph(`Olá, ${strong(firstName(name))}! Este é um teste do canal de e-mails do reWork.`)}
${paragraph('A partir de agora você recebe aqui os avisos de demandas, menções e o resumo do dia — conforme o que estiver ligado no seu perfil.', 8)}`;
  const html = layout({ subject, preheader: 'Canal de e-mails funcionando.', content, baseUrl });
  const text = `Olá ${name}! Este é um teste do canal de e-mails do reWork.`;
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
    { key: 'invite', label: 'Convite para a equipe', build: () => invite({ name: 'Carla Menezes', inviter: name, access: 'Equipe', squads: ['Imob', 'Performance'], link: `${url}/convite/exemplo-de-token-0000`, expiresAt: new Date(Date.now() + 7 * 864e5).toISOString(), baseUrl: url }) },
    { key: 'access_received', label: 'Lista de espera: pedido recebido', build: () => accessRequestReceived({ name: 'Paula Reis', company: 'Agência Norte', baseUrl: url }) },
    { key: 'access_new', label: 'Lista de espera: aviso ao console', build: () => accessRequestNew({ request: { name: 'Paula Reis', email: 'paula@agencianorte.com', company: 'Agência Norte', teamSize: '6-15', role: 'Diretora de operações', message: 'Hoje controlamos tudo em planilha e queremos organizar as demandas por cliente.' }, consoleUrl: `${url}/console/lista-de-espera`, baseUrl: url }) },
    { key: 'console_invite', label: 'Convite de superadmin', build: () => consoleAdminInvite({ name: 'Vinicius Ricarte', inviter: name, link: `${url}/console/ativar/exemplo-0000`, baseUrl: url }) },
    { key: 'console_reset', label: 'Console: redefinir senha', build: () => consoleResetPassword({ name, link: `${url}/console/redefinir/exemplo-0000`, baseUrl: url }) },
    { key: 'console_recovery', label: 'Console: recuperação pelo servidor', build: () => consoleRecoveryNotice({ name: 'Vinicius Ricarte', email: 'vinicius@exemplo.com', baseUrl: url }) },
    { key: 'test', label: 'Teste de e-mail (perfil)', build: () => testEmail({ name, baseUrl: url }) },
  ];
}

module.exports = { escHtml, layout, notification, digest, heldSummary, resetPassword, invite, accessRequestReceived, accessRequestNew, consoleAdminInvite, consoleResetPassword, consoleRecoveryNotice, testEmail, previewSamples };
