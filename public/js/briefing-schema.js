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
      camposCliente: {}, orientacao: '',
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
      pecaAnterior: '', referenciaExtra: '', naoFazer: '', pedidoOriginal: '',
      pecas: []
    }, prefill || {});
  }
  /* Briefings antigos guardavam os campos do cliente na campanha. Agora são
     de cada peça (um set da BRZ pode ter peça SBPE e peça MCMV): copia os
     antigos para as peças e completa o que faltar. */
  function normalize(b) {
    if (!b || !Array.isArray(b.pecas)) return b;
    const old = b.camposCliente && typeof b.camposCliente === 'object' ? b.camposCliente : null;
    b.pecas.forEach(p => {
      if (!p.camposCliente || typeof p.camposCliente !== 'object') p.camposCliente = old ? JSON.parse(JSON.stringify(old)) : {};
      if (typeof p.orientacao !== 'string') p.orientacao = '';
    });
    delete b.camposCliente;
    return b;
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
    if (!b.pecas.length) missing.push({ where: 'pecas', label: 'Pelo menos uma peça' });
    b.pecas.forEach((p, pi) => {
      const pw = 'peca:' + p.id, name = pieceTitle(p, pi);
      if (!p.formatos.length) missing.push({ where: pw, label: `${name}: formato` });
      if (block) for (const f of block.fields) {
        const cc = p.camposCliente || {};
        if (!f.required || !visible(f, cc)) continue;
        if (blank(cc[f.key]) || (cc[f.key] === '__outro__' && blank(cc[f.key + 'Outro']))) missing.push({ where: pw, label: `${name}: ${f.label}` });
      }
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
    const ccOf = p => {
      const cc = p.camposCliente || {}, out = {};
      if (block) for (const f of block.fields) {
        if (!visible(f, cc)) continue;
        const v = cc[f.key];
        out[f.key] = v === '__outro__' ? nn(cc[f.key + 'Outro']) : nn(v);
      }
      return out;
    };
    const perPiece = b.pecas.map(ccOf);
    const camposCliente = {};
    if (perPiece.length) for (const k of Object.keys(perPiece[0])) {
      if (perPiece.every(x => x[k] === perPiece[0][k]) && perPiece[0][k] != null) camposCliente[k] = perPiece[0][k];
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
          campos_cliente: perPiece[pi],
          orientacao: nn(p.orientacao),
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

  /* ── Documento (prévia e Word) ──
     docModel monta a lista de blocos no layout do Word do Agente de Criação:
       { type: 'title', title, line, small }
       { type: 'band', text }                faixa escura numerada
       { type: 'rows', rows: [[rótulo, [valor...]]] }  tabela de duas colunas
       { type: 'sub', text }                 subtítulo (Imagem 1, Capa…)
       { type: 'note', text }                nota em destaque
     Valor de linha: texto, ou { t, tag: true } (etiqueta) / { t, muted: true }.
     Imagem com prévia: linha { img: url }.
     A prévia (toHtml) e o .docx do servidor (briefing-docx.js) desenham o mesmo modelo. */
  function docModel(b, ctx) {
    ctx = ctx || {};
    const client = ctx.client || null;
    const sigla = clientSigla(client);
    const blocks = [];
    const EMPTY = [{ t: '(em branco)', muted: true }];
    const val = s => { const l = String(s == null ? '' : s).split(/\r?\n/).map(x => x.trim()).filter(Boolean); return l.length ? l : EMPTY; };
    const opt = s => { const l = String(s == null ? '' : s).split(/\r?\n/).map(x => x.trim()).filter(Boolean); return l.length ? l : null; };
    const copy = c => !c ? EMPTY : c.naoSeAplica ? [{ t: 'Não se aplica', muted: true }] : c.sugerir ? [{ t: 'Criação sugere', tag: true }] : val(c.texto);
    let n = 1;
    const mm = b.mes ? pad2(b.mes) : '';
    const set = `[${sigla || '?'}] [${mm || '??'}] ${b.campanha || '?'}`;
    blocks.push({
      type: 'title', title: 'Briefing de criativo',
      line: [client ? client.name : '', b.campanha, b.prazo ? 'prazo ' + isoToBr(b.prazo) : ''].filter(Boolean).join(' · '),
      small: [ctx.orgName, 'Criação', set].filter(Boolean).join(' · ')
    });
    if (ctx.status === 'pronto') blocks.push({ type: 'note', text: 'Briefing pronto. Os textos da arte estão escritos exatamente como devem aparecer.' });
    else if (ctx.status) blocks.push({ type: 'note', text: 'Rascunho: este briefing ainda pode mudar.' });

    blocks.push({ type: 'band', text: `${n++}. Campanha` });
    blocks.push({ type: 'rows', rows: [
      ['Cliente', val(client ? client.name : '')],
      ['Nome da campanha', val(b.campanha)],
      ['Mês da campanha', val(b.mes ? `${MONTHS[Number(b.mes) - 1] || ''} (${mm})` : '')],
      ['Prazo de entrega', val(isoToBr(b.prazo))],
      ['Quem pediu', val(b.quemPediu)],
      ['Objetivo', val(b.objetivo)],
      ['Para quem é', val(b.publico)],
      ['Mensagem principal', val(b.mensagem)],
      ['O que a pessoa deve fazer', val(b.acao === '__outro__' ? b.acaoOutro : b.acao)]
    ] });
    const block = clientBlock(client, ctx.blocks);
    if (block && block.note) blocks.push({ type: 'note', text: `${client.name}: ${block.note}` });

    const imageBlocks = (imgs, suffix) => imgs.forEach((im, ii) => {
      blocks.push({ type: 'sub', text: `Imagem ${ii + 1}${suffix ? ' · ' + suffix : ''}` });
      const src = im.url || im.link || '';
      const isImg = /\.(png|jpe?g|webp|gif)(\?|$)/i.test(src) || /^data:image\//.test(src);
      const rows = [
        ['Arquivo ou link', val(im.name || im.link || im.url)],
        ['O que é', val(im.tipo)],
        ['O que mostra', val(im.mostra)],
        ['Uso', val(im.uso)]
      ];
      if (isImg && im.url) rows.push(['Prévia', [{ img: im.url }]]);
      blocks.push({ type: 'rows', rows });
    });

    b.pecas.forEach((p, pi) => {
      const t = pieceType(p.tipo);
      const multi = p.telas.length > 1;
      blocks.push({ type: 'band', text: `${n++}. Peça ${pad2(pi + 1)} · ${t.label}${p.nome ? ' · ' + p.nome : ''} · ${p.formatos.join(', ')}` });
      const rows = [
        ['Tipo de peça', val(t.label)],
        ['Formatos', val(p.formatos.map(f => `${f} (${formatSize(f, client, ctx.blocks)})`).join(', '))]
      ];
      if (multi) rows.push([p.tipo === 'carrossel' ? 'Quantos cards' : 'Telas', val(String(p.telas.length))]);
      if (block) for (const f of block.fields) {
        const cc = p.camposCliente || {};
        if (!visible(f, cc)) continue;
        rows.push([f.label, val(cc[f.key] === '__outro__' ? cc[f.key + 'Outro'] : cc[f.key])]);
      }
      if (opt(p.orientacao)) rows.push(['Orientação', val(p.orientacao)]);
      const telaRows = (tl, isLast) => {
        const r = [
          ['Título', copy(tl.titulo)],
          ['Texto de apoio', copy(tl.apoio)],
          ['Informações', val(lines(tl.informacoes).map(x => '• ' + x).join('\n'))]
        ];
        if (!(multi && tl.cta.naoSeAplica && !isLast)) r.push(['Chamada / botão', copy(tl.cta)]);
        if (tl.semImagem) r.push(['Imagens', [{ t: 'Sem imagem', muted: true }]]);
        return r;
      };
      if (!multi) rows.push(...telaRows(p.telas[0], true));
      if (t.fields.includes('assunto')) rows.push(['Assunto do e-mail', copy(p.assunto)]);
      if (t.fields.includes('preCabecalho')) rows.push(['Pré-cabeçalho', val(p.preCabecalho)]);
      if (t.fields.includes('mensagem')) rows.push(['Mensagem do disparo', copy(p.mensagem)]);
      rows.push(['Oferta / condição', val(p.oferta)]);
      rows.push(['Validade da oferta', val(isoToBr(p.validade))]);
      if (b.objetivo === 'Evento' || p.evento.data || p.evento.hora || p.evento.local) {
        rows.push(['Evento: data, horário e local', val([isoToBr(p.evento.data), p.evento.hora, p.evento.local].filter(Boolean).join(' · '))]);
      }
      rows.push(['Texto legal', p.legal.padrao ? ['Padrão do cliente'] : val(p.legal.texto)]);
      rows.push(['Palavras que precisam aparecer', val(p.obrigatorias.join(', '))]);
      rows.push(['Palavras ou assuntos proibidos', val(p.proibidas.join(', '))]);
      if (opt(p.obs)) rows.push(['Observação', val(p.obs)]);
      blocks.push({ type: 'rows', rows });
      if (!multi) imageBlocks(p.telas[0].imagens);
      if (t.fields.includes('legenda') && copyFilled(p.legenda)) {
        blocks.push({ type: 'sub', text: 'Legenda do post' });
        blocks.push({ type: 'rows', rows: [['Legenda', copy(p.legenda)]] });
      }
      if (multi) p.telas.forEach((tl, ti) => {
        const lbl = telaLabel(p, ti);
        blocks.push({ type: 'sub', text: lbl });
        blocks.push({ type: 'rows', rows: telaRows(tl, ti === p.telas.length - 1) });
        imageBlocks(tl.imagens, lbl);
      });
    });

    blocks.push({ type: 'band', text: `${n++}. Referências e observações` });
    blocks.push({ type: 'rows', rows: [
      ['Peça anterior para seguir', val(b.pecaAnterior)],
      ['Referência visual extra', val(b.referenciaExtra)],
      ['O que NÃO fazer', val(b.naoFazer)],
      ['Pedido original do cliente', val(b.pedidoOriginal)]
    ] });
    return { blocks, set };
  }

  /* Prévia na tela: o mesmo modelo em HTML (faixa escura, rótulo em cinza
     claro, Arial 10 pt), parecido com o Word. */
  function toHtml(b, ctx, opts) {
    opts = opts || {};
    const e = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const imgSrc = opts.imgSrc || (u => u);
    const { blocks } = docModel(b, ctx);
    const cell = v => v.map(x => typeof x === 'string' ? `<p>${e(x)}</p>`
      : x.img ? `<p><img src="${e(imgSrc(x.img) + (/^\/uploads\//.test(x.img) && !opts.office ? '?w=480' : ''))}" alt="" class="thumb"></p>`
      : x.tag ? `<p><span class="tag">${e(x.t)}</span></p>` : `<p class="muted">${e(x.t)}</p>`).join('');
    const html = blocks.map(bl => {
      if (bl.type === 'title') return `<h1>${e(bl.title)}</h1><p class="line">${e(bl.line)}</p><p class="small">${e(bl.small)}</p>`;
      if (bl.type === 'band') return `<div class="band">${e(bl.text)}</div>`;
      if (bl.type === 'note') return `<div class="note">${e(bl.text)}</div>`;
      if (bl.type === 'sub') return `<p class="sub">${e(bl.text)}</p>`;
      return `<table>${bl.rows.map(([k, v]) => `<tr><td class="k">${e(k)}</td><td>${cell(v)}</td></tr>`).join('')}</table>`;
    }).join('\n');
    return `<!doctype html><html><head><meta charset="utf-8"><title>${e(b.campanha || 'Briefing')}</title>
<style>
  body { font-family: Arial, "Liberation Sans", Helvetica, sans-serif; font-size: 10pt; line-height: 1.35; color: #1a1a1a; margin: 0; }
  p { margin: 0 0 3pt; } td p:last-child { margin-bottom: 0; }
  h1 { font-size: 20pt; color: #262626; margin: 0 0 2pt; }
  .line { font-size: 11pt; margin: 0 0 2pt; }
  .small { font-size: 9pt; color: #7f7f7f; margin: 0 0 10pt; }
  .band { background: #262626; color: #fff; font-weight: bold; font-size: 11pt; padding: 5pt 7pt; margin: 14pt 0 0; }
  .note { background: #fff4e5; font-size: 9pt; padding: 5pt 7pt; margin: 0 0 8pt; }
  .sub { font-weight: bold; color: #7f7f7f; margin: 8pt 0 3pt; }
  table { width: 100%; border-collapse: collapse; }
  td { border: 1px solid #bfbfbf; padding: 4.5pt 7pt; vertical-align: top; }
  td.k { width: 33%; background: #f2f2f2; font-weight: bold; }
  .muted { color: #7f7f7f; font-style: italic; }
  .tag { background: #e8f0fe; color: #1a56b0; font-weight: bold; font-size: 8pt; padding: 0 3pt; }
  img.thumb { max-width: 160px; max-height: 120px; }
</style></head><body>${html}</body></html>`;
  }

  /* ── Importar briefing (JSON ou Word) ──
     Aceita:
       - o JSON do reWork (pecas[].telas) e o do Agente de Criação (formato da
         especificação: título/CTA na peça, cards do carrossel, legenda,
         e-mail, WhatsApp, anúncio e notas da copy);
       - o Word gerado pelo agente (tabelas de duas colunas) e o exportado
         pelo reWork (texto corrido "Campo: valor").
     O Word vira primeiro um JSON no formato do agente; os dois caminhos
     terminam em fromAgentJson. Devolve { data, warnings }. */
  const lc = s => norm(s).toLowerCase().replace(/[:.]+$/, '').replace(/\s+/g, ' ').trim();
  const brToIso = s => {
    const v = String(s || '').trim();
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(v); if (m) return `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;
    return '';
  };
  const EMPTY_RE = /^\(?em branco\)?$|^—$|^-$/i;
  const clean = v => { if (v == null) return ''; const s = String(v).trim(); return EMPTY_RE.test(s) ? '' : s; };
  const asList = v => Array.isArray(v) ? v.map(clean).filter(Boolean) : String(v == null ? '' : v).split(/\r?\n|,(?![^(]*\))/).map(x => clean(x.replace(/^[•\-–]\s*/, ''))).filter(Boolean);

  function toCopy(v) {
    const c = emptyCopy();
    if (v == null) return c;
    if (typeof v === 'object' && !Array.isArray(v)) {
      if (v.nao_se_aplica || v.naoSeAplica) { c.naoSeAplica = true; return c; }
      if (v.sugerir && !clean(v.texto)) { c.sugerir = true; return c; }
      c.texto = clean(v.texto); return c;
    }
    const s = clean(Array.isArray(v) ? v.join('\n') : v);
    if (/^\[?cria[cç][aã]o sugere\]?$|^\[?sugerir\]?$/i.test(s)) c.sugerir = true;
    else if (/^n[aã]o se aplica$|^sem cta/i.test(s)) c.naoSeAplica = true;
    else c.texto = s;
    return c;
  }
  // "1x1 (1080×1080), Story (9x16)" → ['1x1', '9x16']
  function parseFormats(v) {
    const raw = Array.isArray(v) ? v.join(',') : String(v || '');
    const out = [];
    const keys = Object.keys(FORMATS).sort((a, b) => b.length - a.length);
    raw.split(/,(?![^(]*\))/).forEach(part => {
      const p = part.trim().toLowerCase();
      if (!p) return;
      let k = keys.find(key => p === key.toLowerCase() || p.startsWith(key.toLowerCase() + ' ') || p.startsWith(key.toLowerCase() + '('));
      if (!k) k = keys.find(key => p.includes('(' + key.toLowerCase() + ')'));
      if (!k && /e-?mail/.test(p)) k = 'email';
      if (!k && /whats|disparo/.test(p)) k = 'disparo';
      if (!k && /carrossel/.test(p)) return;
      if (k && !out.includes(k)) out.push(k);
    });
    return out;
  }
  function guessType(p) {
    const t = lc(p.tipo || '');
    if (PIECE_TYPES.some(x => lc(x.label) === t || x.id === t)) return PIECE_TYPES.find(x => lc(x.label) === t || x.id === t).id;
    const fm = parseFormats(p.formatos);
    if (/carrossel/.test(t) || (Array.isArray(p.cards) && p.cards.length) || Number(p.quantos_cards) > 1) return 'carrossel';
    if (/e-?mail/.test(t) || p.email) return 'email';
    if (/whats|disparo/.test(t) || p.whatsapp) return 'whatsapp';
    if (/banner|display/.test(t)) return 'banner';
    if (/story/.test(t) || (fm.length && fm.every(f => f === '9x16'))) return 'story';
    return 'estatico';
  }
  function toImage(im) {
    if (!im) return null;
    if (typeof im === 'string') im = { arquivo: im };
    const src = clean(im.arquivo || im.url || im.link || '');
    const out = { id: rid(), tipo: '', mostra: clean(im.mostra), uso: '' };
    if (/^\/uploads\//.test(src)) { out.url = src; out.name = clean(im.nome_arquivo || im.name) || src.split('/').pop(); }
    else if (/^https?:\/\//i.test(src)) { out.link = src; if (im.nome_arquivo) out.name = clean(im.nome_arquivo); }
    else { out.link = src; out.name = src; }
    const tipo = IMAGE_TYPES.find(x => lc(x) === lc(im.tipo || '')); if (tipo) out.tipo = tipo;
    const uso = IMAGE_USES.find(x => lc(x) === lc(im.uso || '')); if (uso) out.uso = uso;
    return (src || out.mostra || out.tipo) ? out : null;
  }
  function setSingle(obj, key, value, options, other) {
    const v = clean(value);
    if (!v) return;
    const hit = (options || []).find(o => lc(o) === lc(v));
    if (hit) obj[key] = hit;
    else if (other) { obj[key] = '__outro__'; obj[key + 'Outro'] = v; }
    else obj[key] = v;
  }

  function fromAgentJson(j, ctx) {
    ctx = ctx || {};
    const warnings = [];
    if (!j || typeof j !== 'object' || !Array.isArray(j.pecas)) throw new Error('Este arquivo não parece um briefing: falta a lista de peças.');
    const d = newBriefing();
    // Cliente: id, sigla ou nome contra os clientes do reWork
    const cl = j.cliente || {};
    const clients = ctx.clients || [];
    const cName = typeof cl === 'string' ? cl : (cl.nome || cl.name || '');
    const cSig = typeof cl === 'string' ? '' : String(cl.sigla || '').toUpperCase();
    const client = clients.find(c => c.id && c.id === cl.id)
      || (cSig && clients.find(c => clientSigla(c) === cSig))
      || (cName && clients.find(c => lc(c.name) === lc(cName)))
      || (cName && clients.find(c => lc(cName).startsWith(lc(c.name)) || lc(c.name).startsWith(lc(cName))));
    if (client) d.clienteId = client.id;
    else if (cName || cSig) warnings.push(`O cliente "${cName || cSig}" não foi encontrado no reWork: escolha o cliente na Campanha.`);
    d.campanha = clean(j.campanha);
    const mes = Number(String(j.mes || '').replace(/\D/g, '').slice(-2));
    if (mes >= 1 && mes <= 12) d.mes = String(mes);
    d.prazo = brToIso(j.prazo);
    const g = k => CAMPAIGN_GROUPS.flatMap(x => x.fields).find(f => f.key === k);
    setSingle(d, 'quemPediu', j.quem_pediu, g('quemPediu').options);
    setSingle(d, 'objetivo', j.objetivo, g('objetivo').options);
    setSingle(d, 'publico', j.publico, g('publico').options);
    d.mensagem = clean(j.mensagem_principal || j.mensagem);
    if (clean(j.acao)) {
      const hit = g('acao').options.find(o => lc(o) === lc(j.acao));
      if (hit) d.acao = hit; else { d.acao = '__outro__'; d.acaoOutro = clean(j.acao); }
    }
    const r = j.referencias || {};
    d.pecaAnterior = clean(r.peca_anterior); d.referenciaExtra = clean(r.extra); d.naoFazer = clean(r.nao_fazer);
    d.pedidoOriginal = clean(j.pedido_original);
    // Campos do cliente (de cada peça; os do topo valem para todas): pela chave ou pelo rótulo
    const block = clientBlock(client, ctx.blocks);
    const fillCc = (dst, cc) => {
      if (!block || !cc) return;
      for (const f of block.fields) {
        const v = cc[f.key] != null ? cc[f.key] : Object.entries(cc).find(([k]) => lc(k) === lc(f.label))?.[1];
        if (v == null || !clean(v)) continue;
        if (f.type === 'single') setSingle(dst, f.key, v, f.options, f.other);
        else dst[f.key] = f.type === 'date' ? brToIso(v) || clean(v) : clean(v);
      }
    };
    // Peças
    j.pecas.forEach((p, pi) => {
      const tid = guessType(p);
      const t = pieceType(tid);
      const piece = newPiece(tid);
      const name = `Peça ${pad2(pi + 1)}`;
      piece.nome = clean(p.nome);
      piece.orientacao = clean(p.orientacao);
      fillCc(piece.camposCliente, j.campos_cliente);
      fillCc(piece.camposCliente, p.campos_cliente);
      const fm = parseFormats(p.formatos).filter(f => t.formats.includes(f));
      const dropped = parseFormats(p.formatos).filter(f => !t.formats.includes(f));
      if (fm.length) piece.formatos = fm;
      if (dropped.length) warnings.push(`${name}: o formato ${dropped.join(', ')} não existe para ${t.label} e ficou de fora.`);
      piece.oferta = clean(p.oferta);
      piece.validade = brToIso(p.validade);
      if (p.evento && typeof p.evento === 'object') piece.evento = { data: brToIso(p.evento.data), hora: clean(p.evento.hora), local: clean(p.evento.local) };
      const lg = p.legal;
      if (lg && typeof lg === 'object') piece.legal = { padrao: lg.padrao_cliente !== false && !clean(lg.texto), texto: clean(lg.texto) };
      else if (clean(lg) && !/padr[aã]o do cliente/i.test(lg)) piece.legal = { padrao: false, texto: clean(lg) };
      piece.obrigatorias = asList(p.obrigatorias);
      piece.proibidas = asList(p.proibidas);
      if (t.fields.includes('legenda')) piece.legenda = toCopy(p.legenda);
      if (t.fields.includes('assunto')) piece.assunto = toCopy(p.assunto || (p.email && p.email.assunto));
      if (t.fields.includes('preCabecalho')) piece.preCabecalho = clean(p.pre_cabecalho || (p.email && (p.email.preheader || p.email.pre_cabecalho)));
      if (t.fields.includes('mensagem')) piece.mensagem = toCopy(p.mensagem || (p.whatsapp && p.whatsapp.mensagem));
      // Telas: as do reWork, os cards do agente ou uma tela com os textos da peça
      const mkTela = src => {
        const tl = newTela();
        tl.titulo = toCopy(src.titulo); tl.apoio = toCopy(src.apoio != null ? src.apoio : src.texto);
        tl.informacoes = asList(src.informacoes).join('\n');
        tl.cta = toCopy(src.cta != null ? src.cta : src.botao);
        tl.semImagem = !!src.sem_imagem;
        tl.imagens = (src.imagens || []).map(toImage).filter(Boolean);
        return tl;
      };
      if (Array.isArray(p.telas) && p.telas.length) {
        piece.telas = p.telas.map(mkTela);
      } else if (Array.isArray(p.cards) && p.cards.length && tid === 'carrossel') {
        piece.telas = p.cards.map(c => mkTela({ titulo: c.titulo, apoio: c.texto, informacoes: c.informacoes, imagens: c.imagens }));
        const first = piece.telas[0], last = piece.telas[piece.telas.length - 1];
        if (!BS_copyFilled(first.titulo) && p.titulo) first.titulo = toCopy(p.titulo);
        if (p.cta) last.cta = toCopy(p.cta);
        if (!first.imagens.length && Array.isArray(p.imagens)) first.imagens = p.imagens.map(toImage).filter(Boolean);
      } else {
        const src = Object.assign({}, p);
        if (p.email) { src.titulo = p.titulo || p.email.titulo; src.apoio = p.apoio || p.email.corpo; src.cta = p.cta || p.email.botao; }
        const n = tid === 'carrossel' ? Math.max(t.telas.min, Math.min(t.telas.max, Number(p.quantos_cards) || t.telas.def)) : 1;
        piece.telas = [mkTela(src)];
        for (let i = 1; i < n; i++) piece.telas.push(newTela());
        if (n > 1) { piece.telas[n - 1].cta = piece.telas[0].cta; piece.telas[0].cta = emptyCopy(); }
      }
      if (piece.telas.length > t.telas.max) { warnings.push(`${name}: ${t.label} aceita até ${t.telas.max} telas; as demais ficaram de fora.`); piece.telas = piece.telas.slice(0, t.telas.max); }
      while (piece.telas.length < t.telas.min) piece.telas.push(newTela());
      syncCtas(piece);
      // O que não tem campo próprio vai para a observação da peça
      const obs = [clean(p.observacao || p.obs)];
      const m = p.anuncio && p.anuncio.meta;
      if (m) obs.push(['Anúncio Meta', m.texto_principal && 'Texto principal: ' + m.texto_principal, m.titulo && 'Título: ' + m.titulo, m.descricao && 'Descrição: ' + m.descricao].filter(Boolean).join('\n'));
      const gg = p.anuncio && p.anuncio.google;
      if (gg) obs.push(['Anúncio Google', asList(gg.titulos).length && 'Títulos: ' + asList(gg.titulos).join(' | '), asList(gg.descricoes).length && 'Descrições: ' + asList(gg.descricoes).join(' | ')].filter(Boolean).join('\n'));
      if (p.copy && Array.isArray(p.copy.pendencias) && p.copy.pendencias.length) obs.push('Pendências da copy:\n' + p.copy.pendencias.join('\n'));
      piece.obs = obs.filter(Boolean).join('\n\n');
      d.pecas.push(piece);
    });
    if (!d.pecas.length) warnings.push('O arquivo não tem peças.');
    return { data: d, warnings };
  }
  const BS_copyFilled = c => !!(c && (c.sugerir || c.naoSeAplica || (c.texto && c.texto.trim())));

  /* Word → lista de itens na ordem do documento:
     { h: 'texto' }                       título/seção (ou tabela de uma célula)
     { k: 'rótulo', v: ['linha', ...] }   linha de tabela ou "Rótulo: valor"
     { p: 'texto' }                       parágrafo solto (continuação do rótulo anterior) */
  function docxXmlToItems(xml) {
    const dec = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    const paraText = px => dec((px.match(/<w:t[^>]*>[^<]*<\/w:t>|<w:tab\/>|<w:br\/>/g) || []).map(t => t === '<w:tab/>' ? '\t' : t === '<w:br/>' ? '\n' : t.replace(/<[^>]+>/g, '')).join(''));
    const paras = x => (x.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || []);
    const body = (xml.match(/<w:body>([\s\S]*)<\/w:body>/) || [])[1] || xml;
    const items = [];
    let i = 0;
    while (i < body.length) {
      const nt = body.indexOf('<w:tbl>', i), np = body.search ? body.slice(i).search(/<w:p[ >]/) : -1;
      const pAt = np < 0 ? -1 : i + np;
      if (nt >= 0 && (pAt < 0 || nt < pAt)) {
        // tabela (com tabelas aninhadas contadas)
        let depth = 0, j = nt;
        const re = /<w:tbl>|<\/w:tbl>/g; re.lastIndex = nt;
        let m;
        while ((m = re.exec(body))) { depth += m[0] === '<w:tbl>' ? 1 : -1; if (!depth) { j = re.lastIndex; break; } }
        const tbl = body.slice(nt, j);
        for (const row of (tbl.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) || [])) {
          const cells = (row.match(/<w:tc>[\s\S]*?<\/w:tc>/g) || []).map(c => paras(c).map(paraText).join('\n').split('\n').map(s => s.trim()).filter(Boolean));
          if (cells.length === 1) { if (cells[0].length) items.push({ h: cells[0].join(' ') }); }
          else if (cells.length >= 2) items.push({ k: cells[0].join(' '), v: cells.slice(1).flat() });
        }
        i = j || body.length;
      } else if (pAt >= 0) {
        const end = body.indexOf('</w:p>', pAt);
        const px = body.slice(pAt, end + 6);
        const txt = paraText(px).trim();
        const isHead = /<w:pStyle w:val="(Heading|Ttulo|Titulo|Title)[^"]*"/i.test(px);
        if (txt) {
          if (isHead) items.push({ h: txt });
          else {
            const m = /^([^:]{2,60}):\s*([\s\S]*)$/.exec(txt);
            if (m && !/^https?$/i.test(m[1])) items.push({ k: m[1].trim(), v: m[2] ? m[2].split('\n').map(s => s.trim()).filter(Boolean) : [], open: !m[2] });
            else items.push({ p: txt });
          }
        }
        i = end + 6;
      } else break;
    }
    return items;
  }

  const SECTION_RE = [
    [/^(\d+\.\s*)?campanha$/, 'campanha'],
    [/^(\d+\.\s*)?pe[cç]a\s*(\d+)/, 'peca'],
    [/^(\d+\.\s*)?s[oó] do cliente/, 'cliente'],
    [/^(\d+\.\s*)?refer[eê]ncias/, 'refs'],
    [/^imagem\s*(\d+)$/, 'imagem'],
    [/^cards do carrossel$/, 'cards'],
    [/^legenda do post$/, 'legenda'],
    [/^e-?mail$/, 'email'],
    [/^disparo de whatsapp$/, 'whatsapp'],
    [/^an[uú]ncio meta$/, 'meta'],
    [/^an[uú]ncio google$/, 'google'],
    [/^notas da copy$/, 'notas'],
    [/^(capa|tela \d+|tela [uú]nica)/, 'tela']
  ];
  function itemsToAgentJson(items) {
    const j = { versao: 1, cliente: null, campos_cliente: {}, referencias: {}, pecas: [] };
    let sec = null, piece = null, tela = null, img = null, last = null;
    const camp = { 'cliente': 'cliente', 'nome da campanha': 'campanha', 'mes': 'mes', 'mes da campanha': 'mes', 'prazo de entrega': 'prazo', 'quem pediu': 'quem_pediu', 'objetivo': 'objetivo', 'para quem e': 'publico', 'mensagem principal': 'mensagem_principal', 'o que a pessoa deve fazer': 'acao', 'acao esperada': 'acao' };
    const refs = { 'peca anterior para seguir': 'peca_anterior', 'referencia visual extra': 'extra', 'o que nao fazer': 'nao_fazer' };
    const telaKeys = { 'titulo': 'titulo', 'texto de apoio': 'apoio', 'informacoes': 'informacoes', 'chamada / botao': 'cta', 'chamada (cta)': 'cta', 'chamada / botao (cta)': 'cta' };
    const target = () => tela || piece;
    const put = (it) => {
      const k = lc(it.k), v = it.v;
      const one = v.join('\n');
      if (sec === 'campanha') {
        if (camp[k] === 'cliente') { const m = /^(.*?)\s*\(([A-Z0-9]+)\)\s*$/.exec(one); j.cliente = m ? { nome: m[1], sigla: m[2] } : { nome: one }; }
        else if (camp[k]) j[camp[k]] = one;
        return true;
      }
      if (sec === 'refs' || k === 'pedido original do cliente') {
        if (k === 'pedido original do cliente') j.pedido_original = one;
        else if (refs[k]) j.referencias[refs[k]] = one;
        return true;
      }
      if (sec === 'cliente') { if (k !== 'atencao') j.campos_cliente[it.k] = one; return true; }
      if (!piece) return false;
      if (sec === 'imagem' && img) {
        if (/arquivo/.test(k)) img.arquivo = one; else if (k === 'o que e') img.tipo = one; else if (k === 'o que mostra') img.mostra = one; else if (k === 'uso') img.uso = one;
        return true;
      }
      if (sec === 'cards') { const m = /^card\s*(\d+)/.exec(k); if (m) piece.cards.push({ numero: m[1], titulo: v[0] || '', texto: v.slice(1).join('\n') }); return true; }
      if (sec === 'legenda') { piece.legenda = one; return true; }
      if (sec === 'email') { piece.email = piece.email || {}; const map = { 'assunto': 'assunto', 'pre-header': 'preheader', 'pre-cabecalho': 'preheader', 'titulo': 'titulo', 'corpo': 'corpo', 'botao': 'botao' }; if (map[k]) piece.email[map[k]] = one; return true; }
      if (sec === 'whatsapp') { piece.whatsapp = { mensagem: one }; return true; }
      if (sec === 'meta' || sec === 'google' || sec === 'notas') { piece._extra.push(`${it.k}: ${one}`); return true; }
      // Imagem no texto corrido do reWork: "Imagem 1: Perspectiva 3D · Principal · o que mostra"
      const mi = /^imagem\s*(\d+)$/.exec(k);
      if (mi) {
        const parts = v.flatMap(x => x.split(' · ')).map(x => x.trim()).filter(Boolean);
        const im = { tipo: '', uso: '', mostra: '' };
        parts.forEach(pt => {
          if (IMAGE_TYPES.some(x => lc(x) === lc(pt))) im.tipo = pt;
          else if (IMAGE_USES.some(x => lc(x) === lc(pt))) im.uso = pt;
          else if (/^https?:\/\/|^\/uploads\/|\.(jpe?g|png|webp|gif|psd|tiff?|pdf)$/i.test(pt)) im.arquivo = pt;
          else if (!/^sem descri/i.test(pt)) im.mostra = [im.mostra, pt].filter(Boolean).join(' · ');
        });
        target().imagens.push(im); last = { img: im };
        return true;
      }
      if (telaKeys[k]) { const tg = target(); tg[telaKeys[k]] = telaKeys[k] === 'informacoes' ? v.map(x => x.replace(/^[•\-–]\s*/, '')) : one; return true; }
      const pk = {
        'tipo de peca': 'tipo', 'formatos': 'formatos', 'quantos cards': 'quantos_cards', 'telas': 'quantos_cards',
        'oferta / condicao': 'oferta', 'validade da oferta': 'validade', 'texto legal': 'legal',
        'palavras que precisam aparecer': 'obrigatorias', 'precisa aparecer': 'obrigatorias',
        'palavras ou assuntos proibidos': 'proibidas', 'proibido': 'proibidas', 'observacao': 'observacao',
        'legenda do post': 'legenda', 'assunto do e-mail': 'assunto', 'pre-cabecalho': 'pre_cabecalho', 'mensagem do disparo': 'mensagem', 'orientacao': 'orientacao', 'orientacao para a criacao': 'orientacao'
      }[k];
      if (pk === 'formatos') { piece.formatos = one; return true; }
      if (pk === 'legal') { piece.legal = /padr[aã]o do cliente/i.test(one) ? { padrao_cliente: true } : { padrao_cliente: false, texto: one }; return true; }
      if (pk) { piece[pk] = one; return true; }
      if (/^evento/.test(k)) {
        const parts = one.split(/\s*·\s*|\n/);
        const ev = { data: '', hora: '', local: '' };
        parts.forEach(pt => { if (brToIso(pt)) ev.data = brToIso(pt); else if (/^\d{1,2}[:h]\d{0,2}$/i.test(pt)) ev.hora = pt; else if (pt) ev.local = [ev.local, pt].filter(Boolean).join(' · '); });
        piece.evento = ev; return true;
      }
      // Rótulo desconhecido dentro da peça: campo do cliente (texto corrido do reWork)
      if (sec === 'peca' && !tela && v.length) { piece.campos_cliente[it.k] = one; return true; }
      return false;
    };
    for (const it of items) {
      if (it.h != null || (it.p != null && SECTION_RE.some(([re]) => re.test(lc(it.p))))) {
        const txt = lc(it.h != null ? it.h : it.p);
        const hit = SECTION_RE.find(([re]) => re.test(txt));
        last = null;
        if (!hit) continue;
        const kind = hit[1];
        if (kind === 'peca') {
          // "Peça 01 · Carrossel · nome" (reWork) ou "2. Peça 01 · 1x1, 9x16" (agente)
          const rest = (it.h || it.p).split('·').slice(1).map(s => s.trim());
          piece = { numero: '', tipo: '', formatos: '', imagens: [], cards: [], telas: [], campos_cliente: {}, _extra: [] };
          // a última parte pode ser a lista de formatos ("1x1, 9x16")
          if (rest.length && parseFormats(rest[rest.length - 1]).length) piece.formatos = rest.pop();
          if (rest[0] && PIECE_TYPES.some(x => lc(x.label) === lc(rest[0]))) { piece.tipo = rest.shift(); }
          if (rest.length) piece.nome = rest.join(' · ');
          j.pecas.push(piece); tela = null; img = null; sec = 'peca';
        } else if (kind === 'tela') {
          if (piece) { tela = { titulo: null, apoio: null, informacoes: [], cta: null, imagens: [] }; piece.telas.push(tela); }
        } else if (kind === 'imagem') {
          if (piece) { img = {}; piece.imagens.push(img); }
          sec = 'imagem'; continue;
        } else { tela = kind === 'campanha' || kind === 'cliente' || kind === 'refs' ? null : tela; }
        if (kind !== 'tela' && kind !== 'peca') sec = kind;
        continue;
      }
      if (it.k != null) {
        if (sec === 'imagem' && !/^(arquivo|o que e|o que mostra|uso)/.test(lc(it.k))) sec = 'peca';
        const ok = put(it);
        last = ok ? it : null;
        if (ok && it.open) last = { open: it };
        continue;
      }
      if (it.p != null && last) {
        // Continuação: linhas abaixo de "Rótulo:" no texto corrido do reWork
        if (last.open) { last.open.v.push(it.p); put(Object.assign({}, last.open)); }
        else if (last.img) { last.img.arquivo = last.img.arquivo || it.p; }
      }
    }
    j.pecas.forEach(p => {
      if (p._extra.length) p.observacao = [p.observacao, p._extra.join('\n')].filter(Boolean).join('\n\n');
      delete p._extra;
      if (!p.telas.length) delete p.telas;
      else if (p.imagens.length && !p.telas[0].imagens.length) p.telas[0].imagens = p.imagens;
    });
    return j;
  }
  function fromDocxXml(xml, ctx) {
    const j = itemsToAgentJson(docxXmlToItems(xml));
    if (!j.pecas.length && !j.campanha) throw new Error('Não reconheci este Word como um briefing. Use o Word exportado pelo reWork ou pelo Agente de Criação.');
    return fromAgentJson(j, ctx);
  }

  return {
    VERSION, FORMATS, PIECE_TYPES, PIECE_EXTRA_FIELDS, CAMPAIGN_GROUPS, CLIENT_BLOCKS, IMAGE_TYPES, IMAGE_USES, MONTHS,
    pieceType, clientSigla, clientBlock, visible, formatSize, newBriefing, newPiece, newTela, syncCtas, telaLabel, pieceTitle,
    check, toAgentJson, toHtml, docModel, isoToBr, copyFilled, normalize, fromAgentJson, fromDocxXml, docxXmlToItems, itemsToAgentJson
  };
});
