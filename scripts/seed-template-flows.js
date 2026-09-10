#!/usr/bin/env node
/*
 * seed-template-flows.js — cria fluxos em massa dentro de um projeto de um
 * template de cliente do reWork, via a API REST.
 *
 * Como usar:
 *   1) Edite o bloco CONFIG e o array FLOWS abaixo com o que você quer criar.
 *   2) Rode:  node scripts/seed-template-flows.js
 *      (ou):  BASE_URL=... USERNAME=... PASSWORD=... node scripts/seed-template-flows.js
 *
 * Requisitos: Node 18+ (fetch nativo).
 *
 * O script:
 *   - Faz login via /api/login e guarda o cookie de sessão.
 *   - Descobre o template pelo NOME (ou usa TEMPLATE_ID direto se você passar).
 *   - Descobre o projeto dentro do template pelo NOME (ou pelo índice).
 *   - Cria cada fluxo da lista FLOWS via POST /api/client-templates/:id/projects/:pIdx/flows.
 *   - Loga cada resultado (sucesso, aviso, erro).
 *
 * IMPORTANTE: o server replica automaticamente qualquer fluxo novo pros
 * clientes já criados a partir desse template. Se o número de clientes for
 * grande, o script pode demorar (uma request por fluxo).
 */

'use strict';

// ============================================================================
// CONFIG — edite aqui ou passe via variáveis de ambiente
// ============================================================================
const CONFIG = {
  baseUrl:      process.env.BASE_URL      || 'http://localhost:3000',
  username:     process.env.USERNAME      || 'admin',
  password:     process.env.PASSWORD      || '',        // preencha
  // Você pode identificar o template por ID direto OU pelo nome (case-insensitive).
  templateId:   process.env.TEMPLATE_ID   || '',        // ex.: '0fc0c8a030b6'
  templateName: process.env.TEMPLATE_NAME || 'Agência de Marketing (Teste)',
  // Idem pra projeto: passe o nome exato do projeto DENTRO do template,
  // OU o índice (0 = primeiro projeto).
  projectName:  process.env.PROJECT_NAME  || '',        // ex.: 'Mídias Sociais'
  projectIndex: process.env.PROJECT_INDEX != null ? Number(process.env.PROJECT_INDEX) : 0
};

// ============================================================================
// PALETA — mesma cores que o app oferece pra etapas. Uso opcional só pra
//          referência humana ao editar as stages abaixo.
// ============================================================================
const CORES = {
  cinza:    '#64748B',
  roxo:     '#7A00FF',
  lilas:    '#A855F7',
  rosa:     '#EC4899',
  vermelho: '#EF4444',
  laranja:  '#F59E0B',
  amarelo:  '#EAB308',
  lima:     '#84CC16',
  verde:    '#22C55E',
  esmeralda:'#10B981',
  teal:     '#14B8A6',
  ciano:    '#06B6D4',
  azul:     '#3B82F6',
  indigo:   '#6366F1',
  preto:    '#0F172A',
  vinho:    '#F43F5E'
};

// ============================================================================
// FLUXOS PRA CRIAR — edite este array. Cada item vira um fluxo novo no template.
// ============================================================================
// Campos:
//   name             — nome do fluxo (obrigatório)
//   icon             — ícone lucide (ex.: 'megaphone', 'palette', 'video')
//   demandType       — tipo de demanda (livre, se novo é registrado na biblioteca)
//   stages           — etapas do fluxo, em ordem (mínimo 2)
//     stage.label       — nome (obrigatório)
//     stage.color       — cor hex (use CORES.xxx ou passe hex direto)
//     stage.done        — true na etapa final (concluída)
//     stage.deadlineDays— dias após entrar na etapa pro prazo automático
//                         (opcional; deixe null pra não sugerir prazo)
//   defaultDescription — HTML sanitizado que pré-preenche a descrição na
//                        criação de uma demanda (opcional)
//   defaultChecklist   — checklist padrão: [{ text: '...' }] (opcional)

const FLOWS = [
  // ─── EXEMPLO 1 ───
  {
    name: 'Post estático',
    icon: 'image',
    demandType: 'Social Media',
    stages: [
      { label: 'Briefing',       color: CORES.cinza,     deadlineDays: 1 },
      { label: 'Copy',           color: CORES.azul,      deadlineDays: 2 },
      { label: 'Arte',           color: CORES.roxo,      deadlineDays: 3 },
      { label: 'Revisão interna',color: CORES.laranja,   deadlineDays: 1 },
      { label: 'Aprovação',      color: CORES.rosa,      deadlineDays: 2 },
      { label: 'Publicado',      color: CORES.verde,     done: true }
    ],
    defaultDescription: '',
    defaultChecklist: [
      { text: 'Confirmar formato do post (feed/story/reels)' },
      { text: 'Validar tom de voz com cliente' },
      { text: 'Agendar publicação' }
    ]
  },

  // ─── EXEMPLO 2 ───
  {
    name: 'Reels',
    icon: 'video',
    demandType: 'Social Media',
    stages: [
      { label: 'Briefing',        color: CORES.cinza,   deadlineDays: 1 },
      { label: 'Roteiro',         color: CORES.azul,    deadlineDays: 2 },
      { label: 'Gravação',        color: CORES.laranja, deadlineDays: 3 },
      { label: 'Edição',          color: CORES.roxo,    deadlineDays: 3 },
      { label: 'Revisão interna', color: CORES.amarelo, deadlineDays: 1 },
      { label: 'Aprovação',       color: CORES.rosa,    deadlineDays: 2 },
      { label: 'Publicado',       color: CORES.verde,   done: true }
    ]
  },

  // ─── EXEMPLO 3 ───
  {
    name: 'Anúncio pago',
    icon: 'megaphone',
    demandType: 'Tráfego Pago',
    stages: [
      { label: 'Briefing',            color: CORES.cinza,     deadlineDays: 1 },
      { label: 'Planejamento',        color: CORES.azul,      deadlineDays: 2 },
      { label: 'Criativo',            color: CORES.roxo,      deadlineDays: 3 },
      { label: 'Configuração campanha',color: CORES.indigo,   deadlineDays: 2 },
      { label: 'Aprovação',           color: CORES.rosa,      deadlineDays: 1 },
      { label: 'Ativa',               color: CORES.verde,     done: true }
    ]
  }
];

// ============================================================================
// Implementação — não precisa editar daqui pra baixo
// ============================================================================

const ok = (msg) => console.log(`\x1b[32m✓\x1b[0m ${msg}`);
const warn = (msg) => console.warn(`\x1b[33m⚠\x1b[0m ${msg}`);
const err = (msg) => console.error(`\x1b[31m✗\x1b[0m ${msg}`);
const info = (msg) => console.log(`  ${msg}`);

let SESSION_COOKIE = '';

async function api(path, method = 'GET', body) {
  const res = await fetch(CONFIG.baseUrl + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(SESSION_COOKIE ? { Cookie: SESSION_COOKIE } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status} ${data?.error || ''}`);
  }
  return { data, headers: res.headers };
}

async function login() {
  if (!CONFIG.password) throw new Error('PASSWORD vazia. Preencha CONFIG.password ou passe PASSWORD=... no ambiente.');
  const res = await fetch(CONFIG.baseUrl + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: CONFIG.username, password: CONFIG.password })
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(`Login falhou: ${res.status} ${j.error || ''}`);
  }
  // Cookie do server vem em Set-Cookie
  const setCookie = res.headers.get('set-cookie') || '';
  const match = setCookie.match(/(kastor_session=[^;]+)/);
  if (!match) throw new Error('Login OK mas cookie de sessão não veio.');
  SESSION_COOKIE = match[1];
  const body = await res.json();
  ok(`Login OK como ${body?.user?.name || CONFIG.username}`);
}

async function resolveTemplate() {
  const { data: templates } = await api('/api/client-templates');
  if (!Array.isArray(templates)) throw new Error('Lista de templates inesperada.');
  let t = null;
  if (CONFIG.templateId) {
    t = templates.find(x => x.id === CONFIG.templateId);
    if (!t) throw new Error(`TEMPLATE_ID '${CONFIG.templateId}' não encontrado.`);
  } else if (CONFIG.templateName) {
    t = templates.find(x => (x.name || '').trim().toLowerCase() === CONFIG.templateName.trim().toLowerCase());
    if (!t) {
      err(`Template '${CONFIG.templateName}' não encontrado. Templates disponíveis:`);
      templates.forEach(x => info(`  - ${x.name}  [id=${x.id}]`));
      throw new Error('Ajuste TEMPLATE_NAME ou TEMPLATE_ID.');
    }
  } else {
    throw new Error('Defina TEMPLATE_ID ou TEMPLATE_NAME em CONFIG.');
  }
  ok(`Template: ${t.name}  [id=${t.id}]  (${(t.projects || []).length} projetos)`);
  return t;
}

function resolveProjectIndex(template) {
  const projs = template.projects || [];
  if (!projs.length) throw new Error(`Template '${template.name}' não tem nenhum projeto. Crie um primeiro pela UI.`);
  let idx = -1;
  if (CONFIG.projectName) {
    idx = projs.findIndex(p => (p.name || '').trim().toLowerCase() === CONFIG.projectName.trim().toLowerCase());
    if (idx === -1) {
      err(`Projeto '${CONFIG.projectName}' não encontrado. Disponíveis:`);
      projs.forEach((p, i) => info(`  ${i}: ${p.name}  (${(p.flows || []).length} fluxos)`));
      throw new Error('Ajuste PROJECT_NAME ou PROJECT_INDEX.');
    }
  } else {
    idx = CONFIG.projectIndex;
    if (idx < 0 || idx >= projs.length) throw new Error(`PROJECT_INDEX ${idx} fora do range 0..${projs.length - 1}.`);
  }
  ok(`Projeto: ${projs[idx].name}  [index=${idx}]`);
  return idx;
}

async function createFlow(templateId, projectIdx, flow) {
  const payload = {
    name: flow.name,
    icon: flow.icon || 'workflow',
    demandType: flow.demandType || '',
    stages: (flow.stages || []).map(s => ({
      label: s.label,
      color: s.color,
      done: !!s.done,
      deadlineDays: s.deadlineDays != null ? Number(s.deadlineDays) : null
    })),
    defaultDescription: flow.defaultDescription || '',
    defaultChecklist: (flow.defaultChecklist || []).map(x => ({ text: x.text || '' }))
  };
  try {
    const { data } = await api(`/api/client-templates/${templateId}/projects/${projectIdx}/flows`, 'POST', payload);
    ok(`Fluxo '${flow.name}' criado.`);
    if (data && data.replicatedClients != null) {
      info(`  replicado em ${data.replicatedClients} cliente${data.replicatedClients === 1 ? '' : 's'} existente${data.replicatedClients === 1 ? '' : 's'}.`);
    }
  } catch (e) {
    err(`Falha ao criar '${flow.name}': ${e.message}`);
  }
}

(async function main() {
  try {
    info(`URL: ${CONFIG.baseUrl}`);
    await login();
    const template = await resolveTemplate();
    const pIdx = resolveProjectIndex(template);
    console.log('');
    info(`Vou criar ${FLOWS.length} fluxo${FLOWS.length === 1 ? '' : 's'}:`);
    FLOWS.forEach((f, i) => info(`  ${i + 1}. ${f.name}  (${(f.stages || []).length} etapas)`));
    console.log('');
    for (const f of FLOWS) {
      await createFlow(template.id, pIdx, f);
    }
    console.log('');
    ok('Concluído.');
  } catch (e) {
    err(e.message);
    process.exitCode = 1;
  }
})();
