/* Briefing de criativo — esquema compartilhado (navegador e servidor).
 *
 * Um briefing é uma campanha com uma lista de peças; cada peça tem uma lista
 * de telas (o estático tem 1, o carrossel tem N). Este arquivo define:
 *   - os campos e opções do formulário (o que aparece na tela);
 *   - os tipos de peça (formatos e campos de cada um);
 *   - os campos que só aparecem para um cliente (por sigla ou nome);
 *   - a conferência antes de enviar (o que falta e os alertas);
 *   - o JSON que o Agente de Criação lê;
 *   - o HTML do documento (a prévia na tela e o .docx usam o mesmo).
 *
 * As chaves (key/id) são fixas: são elas que vão no JSON. Os nomes que
 * aparecem na tela podem mudar sem quebrar o agente.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BriefingSchema = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = 1;

  /* ── Formatos ── */
  const FORMATS = {
    '1x1':     { label: 'Quadrado (1x1)',          size: '1080×1080' },
    '4x5':     { label: 'Feed vertical (4x5)',     size: '1080×1350' },
    '9x16':    { label: 'Story (9x16)',            size: '1080×1920' },
    '16x9':    { label: 'Horizontal (16x9)',       size: '1920×1080' },
    '1.91x1':  { label: 'Horizontal / link (1.91x1)', size: '1200×628' },
    'email':   { label: 'E-mail',                  size: '600 px de largura' },
    'disparo': { label: 'WhatsApp (disparo)',      size: '1080×1920' },
    '300x250': { label: '300×250',                 size: '300×250' },
    '728x90':  { label: '728×90',                  size: '728×90' },
    '160x600': { label: '160×600',                 size: '160×600' },
    '300x600': { label: '300×600',                 size: '300×600' },
    '970x250': { label: '970×250',                 size: '970×250' },
    '320x50':  { label: '320×50',                  size: '320×50' }
  };
  // Exceções de tamanho por cliente (sigla).
  const FORMAT_SIZE_BY_CLIENT = {
    VISS: { '1.91x1': '1080×566' },
    MRV:  { '1.91x1': '1080×566' }
  };

  /* ── Tipos de peça ──
     fields: campos extras no nível da peça. telas: mínimo, máximo e padrão. */
  const PIECE_TYPES = [
    { id: 'estatico',  label: 'Estático',  icon: 'image',              desc: 'Post ou anúncio de uma tela',
      formats: ['1x1', '4x5', '9x16', '16x9', '1.91x1'], defaultFormats: ['1x1'], telas: { min: 1, max: 1, def: 1 }, fields: ['legenda'] },
    { id: 'carrossel', label: 'Carrossel', icon: 'gallery-horizontal', desc: 'Várias telas em sequência',
      formats: ['1x1', '4x5'], defaultFormats: ['4x5'], telas: { min: 2, max: 10, def: 3 }, fields: ['legenda'] },
    { id: 'story',     label: 'Story',     icon: 'smartphone',         desc: 'Uma ou mais telas verticais',
      formats: ['9x16'], defaultFormats: ['9x16'], telas: { min: 1, max: 10, def: 1 }, fields: [] },
    { id: 'banner',    label: 'Banner',    icon: 'panels-top-left',    desc: 'Display em vários tamanhos',
      formats: ['300x250', '728x90', '160x600', '300x600', '970x250', '320x50', '1.91x1'], defaultFormats: ['300x250', '728x90'], telas: { min: 1, max: 1, def: 1 }, fields: [] },
    { id: 'email',     label: 'E-mail',    icon: 'mail',               desc: 'E-mail marketing',
      formats: ['email'], defaultFormats: ['email'], telas: { min: 1, max: 1, def: 1 }, fields: ['assunto', 'preCabecalho'] },
    { id: 'whatsapp',  label: 'WhatsApp',  icon: 'message-circle',     desc: 'Imagem de disparo',
      formats: ['disparo'], defaultFormats: ['disparo'], telas: { min: 1, max: 1, def: 1 }, fields: ['mensagem'] }
  ];
  const pieceType = id => PIECE_TYPES.find(t => t.id === id) || PIECE_TYPES[0];

  /* Campos extras da peça (os ids de PIECE_TYPES[].fields). */
  const PIECE_EXTRA_FIELDS = {
    legenda:      { label: 'Legenda do post', type: 'copy', multiline: true, placeholder: 'Texto que vai na publicação, fora da arte' },
    assunto:      { label: 'Assunto do e-mail', type: 'copy', placeholder: 'Ex.: Últimas unidades do Legacy' },
    preCabecalho: { label: 'Pré-cabeçalho', type: 'text', placeholder: 'Linha que aparece depois do assunto na caixa de entrada' },
    mensagem:     { label: 'Mensagem do disparo', type: 'copy', multiline: true, placeholder: 'Texto que acompanha a imagem no WhatsApp' }
  };

  /* ── Campos da campanha ── */
  const MONTHS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  const CAMPAIGN_GROUPS = [
    { id: 'campanha', label: 'Campanha', fields: [
      { key: 'clienteId', label: 'Cliente', type: 'client', required: true },
      { key: 'campanha', label: 'Nome da campanha', type: 'text', required: true, placeholder: 'Ex.: 80% Vendido, Copa Fase 2', hint: 'Como o time chama. Vai no nome dos arquivos.' },
      { key: 'mes', label: 'Mês da campanha', type: 'month', required: true },
      { key: 'prazo', label: 'Prazo de entrega', type: 'date', required: true },
      { key: 'quemPediu', label: 'Quem pediu', type: 'single', options: ['Cliente', 'Atendimento', 'Criação'] }
    ] },
    { id: 'objetivo', label: 'Objetivo', fields: [
      { key: 'objetivo', label: 'Objetivo', type: 'single', required: true,
        options: ['Lançamento', 'Oferta / condição', 'Evento', 'Evolução de obra', 'Institucional', 'Data comemorativa', 'Post de rede social', 'Campanha para corretores'] },
      { key: 'publico', label: 'Para quem é', type: 'single', required: true,
        options: ['Cliente final', 'Corretores', 'Investidores', 'Brasileiros no exterior'] },
      { key: 'mensagem', label: 'Mensagem principal', type: 'text', required: true, placeholder: 'Uma frase: o que a pessoa precisa entender em 2 segundos' },
      { key: 'acao', label: 'O que a pessoa deve fazer', type: 'single', required: true, other: true,
        options: ['Agendar visita', 'Chamar no WhatsApp', 'Clicar no link', 'Ir ao evento'] }
    ] },
    { id: 'referencias', label: 'Referências', fields: [
      { key: 'pecaAnterior', label: 'Peça anterior para seguir', type: 'text', placeholder: 'Nome ou link' },
      { key: 'referenciaExtra', label: 'Referência visual extra', type: 'textarea', placeholder: 'Link ou descrição, e o que aproveitar dela' },
      { key: 'naoFazer', label: 'O que NÃO fazer', type: 'textarea', placeholder: 'Ex.: não usar bordô' },
      { key: 'pedidoOriginal', label: 'Pedido original do cliente', type: 'textarea', rows: 5, placeholder: 'Cole aqui o e-mail ou a mensagem do cliente' }
    ] }
  ];

  /* ── Campos só de um cliente ──
     Chave = sigla. O cliente casa pela sigla do cadastro ou, sem sigla, pela
     primeira palavra do nome. */
  const CLIENT_BLOCKS = {
    BRZ: { fields: [
      { key: 'segmento', label: 'Segmento', type: 'single', required: true, options: ['MCMV', 'SBPE'], hint: 'Define cor e estilo: MCMV cereja, SBPE teal.' },
      { key: 'produto', label: 'Produto', type: 'text', placeholder: 'Ex.: Portal Orion' },
      { key: 'fase', label: 'Fase', type: 'single', other: true, options: ['Breve lançamento', 'Lançamento', 'Obras aceleradas', 'Pronto para morar'] },
      { key: 'tipologia', label: 'Tipologia e destaque', type: 'text', placeholder: 'Ex.: 2 dorms, lazer completo' },
      { key: 'condicao', label: 'Condição', type: 'text', placeholder: 'Renda familiar, mensais, entrada' },
      { key: 'cidadeBairro', label: 'Cidade e bairro', type: 'text' }
    ] },
    TACK: { fields: [
      { key: 'linha', label: 'Linha', type: 'single', required: true, options: ['Tack institucional', 'Pulso Saúde'] },
      { key: 'faseCampanha', label: 'Fase da campanha', type: 'text', placeholder: 'Ex.: Fase 02' },
      { key: 'statusProduto', label: 'Status do produto', type: 'single', other: true, options: ['Breve lançamento', 'Lançamento'] },
      { key: 'tema', label: 'Tema da peça', type: 'text', placeholder: 'Metrô, lazer, rotina, morar, investir…' },
      { key: 'seloMcmv', label: 'Selo MCMV / "Use seu FGTS"', type: 'single', options: ['Sim', 'Não'], showIf: c => c.linha === 'Pulso Saúde' },
      { key: 'textosLegais', label: 'Textos legais', type: 'textarea', placeholder: 'Texto exato, com R.I., CRECI e condições', showIf: c => c.linha === 'Pulso Saúde' }
    ] },
    VISS: { note: 'Não comunicar faixa de renda. Não usar bordô.', fields: [
      { key: 'marca', label: 'Marca da peça', type: 'single', required: true, options: ['Legacy by VISS', 'VISS institucional'] },
      { key: 'evento', label: 'Nome do evento', type: 'text', placeholder: 'Ex.: Parrilla & Legacy' },
      { key: 'dadoObraVendas', label: 'Dado de obra / vendas', type: 'text', placeholder: 'Ex.: 30% da obra, 80% vendido' }
    ] },
    MRV: { fields: [
      { key: 'frente', label: 'Frente', type: 'single', required: true, options: ['MRV (brasileiros no exterior)', 'Escopo de Criação (corretores)'] },
      { key: 'programa', label: 'Programa', type: 'text', placeholder: 'Ex.: Bateu Levou, Quiosque, Mês do Corretor', showIf: c => /Escopo/.test(c.frente || '') },
      { key: 'cidadeEmpreendimento', label: 'Cidade / empreendimento', type: 'text', placeholder: 'Ou "institucional, todo o Brasil"' },
      { key: 'premioRegra', label: 'Prêmio / regra da campanha', type: 'textarea', showIf: c => /Escopo/.test(c.frente || '') }
    ] }
  };

  /* ── Imagens ── */
  const IMAGE_TYPES = ['Foto real', 'Foto de banco', 'Perspectiva 3D', 'Foto real da obra', 'Planta', 'Produto / prêmio'];
  const IMAGE_USES = ['Principal', 'Secundária', 'Fundo'];

  /* ── Utilitários ── */
  const rid = () => Math.random().toString(36).slice(2, 10);
  const pad2 = n => String(n).padStart(2, '0');
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  const FORBIDDEN_FILE_CHARS = /[\/\\:*?"<>|]/;
  const blank = v => v == null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);
  const copyFilled = c => !!(c && (c.sugerir || c.naoSeAplica || (c.texto && c.texto.trim())));
  const isoToBr = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || ''); };
  const lines = s => String(s || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);

  function clientSigla(client) {
    if (!client) return '';
    if (client.sigla && String(client.sigla).trim()) return String(client.sigla).trim().toUpperCase();
    return norm(client.name).split(/\s+/)[0].toUpperCase().replace(/[^A-Z0-9]/g, '');
  }
  /* Campo condicional: função (blocos daqui) ou objeto vindo do agente
     { campo, igual } / { campo, contem }. */
  function visible(f, obj) {
    const c = f && f.showIf;
    if (!c) return true;
    if (typeof c === 'function') return !!c(obj || {});
    const v = String((obj || {})[c.campo] == null ? '' : (obj || {})[c.campo]);
    if (c.igual != null) return v === String(c.igual);
    if (c.contem != null) return v.toLowerCase().includes(String(c.contem).toLowerCase());
    return true;
  }
  /* Bloco "Só do cliente". blocks = os do Agente de Criação (GitHub), por
     sigla; sem eles (ou sem o cliente lá), usa os embutidos aqui. */
  function clientBlock(client, blocks) {
    if (!client) return null;
    const s = clientSigla(client);
    const nm = norm(client.name).toLowerCase();
    const first = norm(client.name).split(/\s+/)[0].toUpperCase();
    if (blocks && typeof blocks === 'object') {
      const list = Object.values(blocks);
      const hit = blocks[s] || list.find(b => norm(b.nome).toLowerCase() === nm) || blocks[first];
      if (hit) return { sigla: hit.sigla, note: hit.aviso || null, fields: hit.campos || [], proibidas: hit.proibidas_padrao || [], tamanhos: hit.tamanhos || {}, origem: 'agente' };
      return null;
    }
    const key = CLIENT_BLOCKS[s] ? s : (CLIENT_BLOCKS[first] ? first : null);
    if (!key) return null;
    return { sigla: key, ...CLIENT_BLOCKS[key], proibidas: [], tamanhos: FORMAT_SIZE_BY_CLIENT[key] || {}, origem: 'reWork' };
  }
  function formatSize(fmt, client, blocks) {
    const b = clientBlock(client, blocks);
    return (b && b.tamanhos && b.tamanhos[fmt]) || (FORMATS[fmt] && FORMATS[fmt].size) || '';
  }

  /* ── Criação ── */
  const emptyCopy = () => ({ texto: '', sugerir: false, naoSeAplica: false });
  function newTela() {
    return { id: rid(), titulo: emptyCopy(), apoio: emptyCopy(), informacoes: '', cta: emptyCopy(), semImagem: false, imagens: [] };
  }
  function newPiece(typeId) {
    const t = pieceType(typeId);
    const p = {
      id: rid(), tipo: t.id, nome: '', formatos: t.defaultFormats.slice(),
      legenda: emptyCopy(), assunto: emptyCopy(), preCabecalho: '', mensagem: emptyCopy(),
      oferta: '', validade: '', evento: { data: '', hora: '', local: '' },
      legal: { padrao: true, texto: '' }, obrigatorias: [], proibidas: [], obs: '',
      telas: []
    };
    for (let i = 0; i < t.telas.def; i++) p.telas.push(newTela());
    syncCtas(p);
    return p;
  }
  /* Carrossel/story: o CTA vem por padrão só na última tela. As do meio
     começam como "não se aplica" (a pessoa pode mudar). */
  function syncCtas(p) {
    const n = p.telas.length;
    p.telas.forEach((t, i) => {
      if (n > 1 && i < n - 1 && !t.cta.texto && !t.cta.sugerir && !t._ctaTouched) t.cta.naoSeAplica = true;
      if (i === n - 1 && t.cta.naoSeAplica && !t._ctaTouched) t.cta.naoSeAplica = false;
    });
  }
  function newBriefing(prefill) {
    return Object.assign({
      v: VERSION, clienteId: null, campanha: '', mes: '', prazo: '', quemPediu: '',
      objetivo: '', publico: '', mensagem: '', acao: '', acaoOutro: '',
      camposCliente: {}, pecaAnterior: '', referenciaExtra: '', naoFazer: '', pedidoOriginal: '',
      pecas: []
    }, prefill || {});
  }
  function telaLabel(p, i) {
    const n = p.telas.length;
    if (n === 1) return 'Tela única';
    if (p.tipo === 'carrossel') return i === 0 ? 'Capa' : (i === n - 1 ? `Tela ${i + 1} · fechamento` : `Tela ${i + 1}`);
    return `Tela ${i + 1}`;
  }
  function pieceTitle(p, i) {
    const t = pieceType(p.tipo);
    return `${pad2(i + 1)} · ${p.nome && p.nome.trim() ? p.nome.trim() : t.label}`;
  }

  /* ── Conferência ──
     missing: obrigatórios vazios (cada um com onde fica). alerts: avisos. */
  function check(b, ctx) {
    ctx = ctx || {};
    const client = ctx.client || null;
    const missing = [], alerts = [];
    const today = ctx.today || new Date().toISOString().slice(0, 10);
    for (const g of CAMPAIGN_GROUPS) for (const f of g.fields) {
      if (!f.required || !visible(f, b)) continue;
      const v = b[f.key];
      if (f.key === 'acao' && v === '__outro__') { if (blank(b.acaoOutro)) missing.push({ where: g.id, label: f.label }); continue; }
      if (blank(v)) missing.push({ where: g.id, label: f.label });
    }
    if (b.campanha && FORBIDDEN_FILE_CHARS.test(b.campanha)) alerts.push({ where: 'campanha', text: 'O nome da campanha tem caracteres que não podem ir no nome do arquivo: / \\ : * ? " < > |' });
    if (b.prazo && b.prazo < today) alerts.push({ where: 'campanha', text: 'O prazo de entrega já passou.' });
    const block = clientBlock(client, ctx.blocks);
    if (block) for (const f of block.fields) {
      if (!f.required || !visible(f, b.camposCliente)) continue;
      if (blank((b.camposCliente || {})[f.key])) missing.push({ where: 'cliente', label: f.label });
    }
    if (!b.pecas.length) missing.push({ where: 'pecas', label: 'Pelo menos uma peça' });
    b.pecas.forEach((p, pi) => {
      const pw = 'peca:' + p.id, name = pieceTitle(p, pi);
      if (!p.formatos.length) missing.push({ where: pw, label: `${name}: formato` });
      if (p.validade && p.validade < today) alerts.push({ where: pw, text: `${name}: a validade da oferta já passou.` });
      if (b.objetivo === 'Evento' && (blank(p.evento.data) || blank(p.evento.local))) alerts.push({ where: pw, text: `${name}: o objetivo é Evento, mas falta a data ou o local.` });
      if (p.evento.data && p.evento.data < today) alerts.push({ where: pw, text: `${name}: a data do evento já passou.` });
      const has3d = p.telas.some(t => t.imagens.some(im => im.tipo === 'Perspectiva 3D'));
      if (has3d && !p.legal.padrao && !/ilustrad/i.test(p.legal.texto || '')) alerts.push({ where: pw, text: `${name}: tem perspectiva 3D e o texto legal não diz "ilustrada" ou "ilustrativa".` });
      p.telas.forEach((t, ti) => {
        const tn = p.telas.length > 1 ? `${name}, ${telaLabel(p, ti)}` : name;
        if (!copyFilled(t.titulo)) missing.push({ where: pw, label: `${tn}: título` });
        if (!copyFilled(t.cta)) missing.push({ where: pw, label: `${tn}: chamada (CTA)` });
        if (!t.semImagem && !t.imagens.length) missing.push({ where: pw, label: `${tn}: imagem (ou marque "sem imagem")` });
        t.imagens.forEach((im, ii) => { if (!im.tipo) alerts.push({ where: pw, text: `${tn}: a imagem ${ii + 1} está sem "O que é".` }); });
      });
    });
    return { missing, alerts, ok: !missing.length && !alerts.length };
  }

  /* ── JSON para o agente ──
     null = não preenchido (o agente pergunta); sugerir = o agente escreve;
     nao_se_aplica = de propósito não tem. Datas em AAAA-MM-DD. */
  function toAgentJson(b, ctx) {
    ctx = ctx || {};
    const client = ctx.client || null;
    const sigla = clientSigla(client);
    const nn = v => (blank(v) ? null : v);
    const cp = c => (c && c.naoSeAplica) ? { texto: null, sugerir: false, nao_se_aplica: true }
                  : { texto: c && !c.sugerir ? nn((c.texto || '').trim()) : null, sugerir: !!(c && c.sugerir) };
    const absUrl = u => (u && ctx.baseUrl && u.startsWith('/')) ? ctx.baseUrl.replace(/\/$/, '') + u : u;
    const campanha = (b.campanha || '').trim();
    const mm = b.mes ? pad2(b.mes) : null;
    const block = clientBlock(client, ctx.blocks);
    const camposCliente = {};
    if (block) for (const f of block.fields) {
      if (!visible(f, b.camposCliente)) continue;
      const v = (b.camposCliente || {})[f.key];
      camposCliente[f.key] = v === '__outro__' ? nn((b.camposCliente || {})[f.key + 'Outro']) : nn(v);
    }
    return {
      versao: VERSION,
      origem: ctx.origem || null,
      cliente: client ? { id: client.id, nome: client.name, sigla } : null,
      campanha: nn(campanha),
      mes: mm,
      prazo: nn(b.prazo),
      quem_pediu: nn(b.quemPediu),
      objetivo: nn(b.objetivo),
      publico: nn(b.publico),
      mensagem_principal: nn(b.mensagem),
      acao: b.acao === '__outro__' ? nn(b.acaoOutro) : nn(b.acao),
      campos_cliente: camposCliente,
      pecas: b.pecas.map((p, pi) => {
        const t = pieceType(p.tipo);
        const num = pad2(pi + 1);
        const base = sigla && mm && campanha ? `[${sigla}] [${mm}] ${campanha} - ${num}` : null;
        const multi = p.telas.length > 1;
        const arquivos = base ? p.formatos.flatMap(f => p.telas.map((_, ti) =>
          `${sigla}/${base}/${base} - ${f}${multi ? ' - ' + pad2(ti + 1) : ''}.png`)) : [];
        const out = {
          numero: num,
          tipo: t.label,
          nome: nn(p.nome),
          formatos: p.formatos.slice(),
          tamanhos: Object.fromEntries(p.formatos.map(f => [f, formatSize(f, client, ctx.blocks)])),
          oferta: nn(p.oferta),
          validade: nn(p.validade),
          evento: (p.evento.data || p.evento.hora || p.evento.local) ? { data: nn(p.evento.data), hora: nn(p.evento.hora), local: nn(p.evento.local) } : null,
          legal: { padrao_cliente: !!p.legal.padrao, texto: p.legal.padrao ? null : nn(p.legal.texto) },
          obrigatorias: p.obrigatorias.slice(),
          proibidas: p.proibidas.slice(),
          observacao: nn(p.obs),
          telas: p.telas.map((tl, ti) => ({
            numero: pad2(ti + 1),
            titulo: cp(tl.titulo),
            apoio: (blank(tl.apoio.texto) && !tl.apoio.sugerir && !tl.apoio.naoSeAplica) ? null : cp(tl.apoio),
            informacoes: lines(tl.informacoes),
            cta: cp(tl.cta),
            sem_imagem: !!tl.semImagem,
            imagens: tl.imagens.map(im => ({
              arquivo: nn(absUrl(im.url || im.link || '')), nome_arquivo: nn(im.name), tipo: nn(im.tipo), mostra: nn(im.mostra), uso: nn(im.uso)
            }))
          })),
          arquivos
        };
        for (const fid of t.fields) {
          const v = p[fid];
          out[fid === 'preCabecalho' ? 'pre_cabecalho' : fid] = typeof v === 'string' ? nn(v) : cp(v);
        }
        return out;
      }),
      referencias: { peca_anterior: nn(b.pecaAnterior), extra: nn(b.referenciaExtra), nao_fazer: nn(b.naoFazer) },
      pedido_original: nn(b.pedidoOriginal)
    };
  }

  /* ── HTML do documento (prévia e .docx) ──
     opts.office: true na conversão pro Word (inclui rodapé com nº da página).
     opts.imgSrc(url): resolve o endereço da imagem (o servidor troca por file://). */
  function toHtml(b, ctx, opts) {
    ctx = ctx || {}; opts = opts || {};
    const client = ctx.client || null;
    const e = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const br = s => e(s).replace(/\r?\n/g, '<br>');
    const SUG = '<span class="tag">Criação sugere</span>';
    const NA = '<span class="muted">Não se aplica</span>';
    const copy = c => !c ? '' : c.naoSeAplica ? NA : c.sugerir ? SUG : br((c.texto || '').trim());
    const rows = [];
    const row = (label, val) => { if (val && String(val).trim()) rows.push(`<tr><td class="k">${e(label)}</td><td class="v">${val}</td></tr>`); };
    const flush = () => { const h = rows.length ? `<table>${rows.join('')}</table>` : ''; rows.length = 0; return h; };
    const band = t => `<h2 class="band">${e(t)}</h2>`;
    const sub = t => `<h3>${e(t)}</h3>`;
    const imgSrc = opts.imgSrc || (u => u);
    let html = '';

    const mesTxt = b.mes ? `${MONTHS[Number(b.mes) - 1] || ''} (${pad2(b.mes)})` : '';
    html += `<p class="kicker">Briefing de criativo</p><h1>${e(b.campanha || 'Campanha sem nome')}</h1>`;
    html += `<p class="meta">${[client ? e(client.name) : '', b.prazo ? 'Entrega ' + e(isoToBr(b.prazo)) : '', b.pecas.length ? b.pecas.length + (b.pecas.length > 1 ? ' peças' : ' peça') : ''].filter(Boolean).join(' · ')}</p>`;

    html += band('Campanha');
    row('Cliente', client ? e(client.name) + (clientSigla(client) ? ` <span class="muted">(${e(clientSigla(client))})</span>` : '') : '');
    row('Nome da campanha', e(b.campanha));
    row('Mês', e(mesTxt));
    row('Prazo de entrega', e(isoToBr(b.prazo)));
    row('Quem pediu', e(b.quemPediu));
    row('Objetivo', e(b.objetivo));
    row('Para quem é', e(b.publico));
    row('Mensagem principal', br(b.mensagem));
    row('O que a pessoa deve fazer', e(b.acao === '__outro__' ? b.acaoOutro : b.acao));
    html += flush();

    b.pecas.forEach((p, pi) => {
      const t = pieceType(p.tipo);
      html += band(`Peça ${pad2(pi + 1)} · ${t.label}${p.nome ? ' · ' + p.nome : ''}`);
      row('Formatos', e(p.formatos.map(f => `${f} (${formatSize(f, client, ctx.blocks)})`).join(', ')));
      if (p.telas.length > 1) row('Telas', String(p.telas.length));
      for (const fid of t.fields) {
        const def = PIECE_EXTRA_FIELDS[fid];
        row(def.label, typeof p[fid] === 'string' ? br(p[fid]) : copy(p[fid]));
      }
      row('Oferta / condição', br(p.oferta));
      row('Validade da oferta', e(isoToBr(p.validade)));
      if (p.evento.data || p.evento.hora || p.evento.local) row('Evento', e([isoToBr(p.evento.data), p.evento.hora, p.evento.local].filter(Boolean).join(' · ')));
      row('Texto legal', p.legal.padrao ? '<span class="muted">Padrão do cliente</span>' : br(p.legal.texto));
      row('Precisa aparecer', e(p.obrigatorias.join(', ')));
      row('Proibido', e(p.proibidas.join(', ')));
      row('Observação', br(p.obs));
      html += flush();
      p.telas.forEach((tl, ti) => {
        if (p.telas.length > 1) html += sub(telaLabel(p, ti));
        row('Título', copy(tl.titulo));
        row('Texto de apoio', copy(tl.apoio));
        const inf = lines(tl.informacoes);
        if (inf.length) row('Informações', inf.map(x => '• ' + e(x)).join('<br>'));
        // Tela do meio de carrossel sem CTA: não polui o documento.
        if (!(tl.cta.naoSeAplica && p.telas.length > 1)) row('Chamada (CTA)', copy(tl.cta));
        if (tl.semImagem) row('Imagens', '<span class="muted">Sem imagem</span>');
        tl.imagens.forEach((im, ii) => {
          const src = im.url || im.link || '';
          const isImg = /\.(png|jpe?g|webp|gif)(\?|$)/i.test(src) || /^data:image\//.test(src);
          const thumb = isImg ? `<img class="thumb" src="${e(imgSrc(src))}" alt="">` : '';
          const info = [im.tipo && `<strong>${e(im.tipo)}</strong>`, im.uso && e(im.uso), im.mostra && e(im.mostra), (im.name || im.link) && `<span class="muted">${e(im.name || im.link)}</span>`].filter(Boolean).join('<br>');
          row(`Imagem ${ii + 1}`, thumb + info);
        });
        html += flush();
      });
    });

    const block = clientBlock(client, ctx.blocks);
    if (block) {
      html += band('Só do cliente');
      for (const f of block.fields) {
        if (!visible(f, b.camposCliente)) continue;
        let v = (b.camposCliente || {})[f.key];
        if (v === '__outro__') v = (b.camposCliente || {})[f.key + 'Outro'];
        row(f.label, br(v));
      }
      if (block.note) row('Atenção', e(block.note));
      html += flush();
    }

    row('Peça anterior para seguir', br(b.pecaAnterior));
    row('Referência visual extra', br(b.referenciaExtra));
    row('O que NÃO fazer', br(b.naoFazer));
    row('Pedido original do cliente', br(b.pedidoOriginal));
    if (rows.length) html = html + band('Referências') + flush();

    const pageNo = '<sdfield type=PAGE subtype=RANDOM format=PAGE>1</sdfield>';
    const footer = opts.office ? `<div title="footer"><p style="font-size:8pt;color:#777;margin:0;text-align:right">${pageNo}</p></div>` : '';
    return `<!doctype html><html><head><meta charset="utf-8"><title>${e(b.campanha || 'Briefing')}</title>
<style>
  @page { size: 210mm 297mm; margin: 20mm; }
  body { font-family: Arial, "Liberation Sans", Helvetica, sans-serif; font-size: 10pt; line-height: 1.4; color: #1a1a1a; margin: 0; }
  .kicker { font-size: 8pt; letter-spacing: .08em; text-transform: uppercase; color: #777; margin: 0 0 2pt; }
  h1 { font-size: 20pt; margin: 0 0 4pt; }
  .meta { color: #555; margin: 0 0 12pt; }
  h2.band { background: #1f1f24; color: #fff; font-size: 10.5pt; padding: 5pt 8pt; margin: 16pt 0 6pt; }
  h3 { font-size: 10pt; margin: 10pt 0 4pt; color: #333; }
  table { width: 100%; border-collapse: collapse; margin: 0 0 4pt; }
  td { border: 1px solid #d9d9de; padding: 5pt 7pt; vertical-align: top; }
  td.k { width: 32%; background: #f1f1f4; color: #444; }
  .tag { display: inline-block; background: #ede4ff; color: #5a1fc2; border-radius: 3pt; padding: 1pt 5pt; font-size: 8.5pt; font-weight: bold; }
  .muted { color: #888; }
  img.thumb { display: block; max-width: 140pt; max-height: 100pt; margin: 0 0 4pt; }
</style></head><body>${footer}${html}</body></html>`;
  }

  return {
    VERSION, FORMATS, PIECE_TYPES, PIECE_EXTRA_FIELDS, CAMPAIGN_GROUPS, CLIENT_BLOCKS, IMAGE_TYPES, IMAGE_USES, MONTHS,
    pieceType, clientSigla, clientBlock, visible, formatSize, newBriefing, newPiece, newTela, syncCtas, telaLabel, pieceTitle,
    check, toAgentJson, toHtml, isoToBr, copyFilled
  };
});
