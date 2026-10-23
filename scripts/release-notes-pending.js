#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────
   reWork — commits que ainda não viraram Novidade

   Lista os commits desde a última vez que release-notes.json mudou e que
   podem ter algo para contar no painel de Novidades. Rode antes do deploy
   ou use pelo /novidades do Claude:

     node scripts/release-notes-pending.js            # lista com o texto de cada commit
     node scripts/release-notes-pending.js --short    # só hash, data e assunto
     node scripts/release-notes-pending.js --json     # idem, em JSON (com o corpo)
     node scripts/release-notes-pending.js --check    # sai com código 1 se houver pendente
     node scripts/release-notes-pending.js --since <ref>   # outra base no lugar da automática

   Entra feat, fix e perf, e assunto fora do padrão (ex.: "Celular: ...").
   Fica de fora deploy, chore, ci, build, docs, test, refactor, style e merge.
   Commit que não interessa ao usuário pode levar a linha "Novidades: não"
   no corpo e some da lista. A lista é um ponto de partida: correção
   interna, console e coisas do servidor não viram nota.
   ───────────────────────────────────────────────────────────── */
const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NOTES = 'release-notes.json';
const SKIP_TYPES = new Set(['deploy', 'chore', 'ci', 'build', 'docs', 'test', 'refactor', 'style', 'revert']);
const OPT_OUT = /^novidades?:\s*n[ãa]o\s*$/im;

const args = process.argv.slice(2);
const flag = f => args.includes(f);
const sinceIdx = args.indexOf('--since');

function git(...a) { return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim(); }

let base = sinceIdx >= 0 ? args[sinceIdx + 1] : git('log', '-1', '--format=%H', '--', NOTES);
if (!base) { console.error(`Não achei commit que mexeu em ${NOTES}. Passe --since <ref>.`); process.exit(2); }

const SEP = '\u001e', FS = '\u001f';
const raw = git('log', `${base}..HEAD`, '--no-merges', '--date=short', `--format=%h${FS}%ad${FS}%s${FS}%b${SEP}`);
const commits = raw.split(SEP).map(s => s.trim()).filter(Boolean).map(s => {
  const [hash, date, subject, body = ''] = s.split(FS);
  const type = (subject.match(/^([a-z]+)(\([^)]*\))?!?:/) || [])[1] || null;
  return { hash, date, subject, type, body: body.replace(/^Co-Authored-By:.*$|^Claude-Session:.*$/gim, '').trim() };
});
const pending = commits.filter(c => !(c.type && SKIP_TYPES.has(c.type)) && !OPT_OUT.test(c.body));

const dirty = git('status', '--porcelain', '--', NOTES);
const baseLabel = git('log', '-1', '--format=%h %ad', '--date=short', base);

if (flag('--json')) {
  console.log(JSON.stringify({ base: baseLabel, notesUncommitted: !!dirty, pending }, null, 2));
} else {
  console.log(`Base: ${baseLabel}${sinceIdx >= 0 ? '' : ` (último commit em ${NOTES})`}`);
  if (dirty) console.log(`Aviso: ${NOTES} tem alterações ainda não commitadas.`);
  if (!pending.length) console.log('Nada pendente para o painel de Novidades.');
  else {
    console.log(`${pending.length} commit(s) para avaliar:\n`);
    for (const c of pending.slice().reverse()) {
      console.log(`${c.hash}  ${c.date}  ${c.subject}`);
      if (!flag('--short') && c.body) console.log(c.body.replace(/^/gm, '    ') + '\n');
    }
  }
}
if (flag('--check') && pending.length) process.exit(1);
