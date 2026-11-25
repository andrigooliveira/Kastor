/* ───────────────────────────────────────────────────────────────
   reWork — Permissões hierárquicas da Agenda (sem banco)
   Roda com: node --test tests/schedule-permissions.test.js

   Verifica que tanto o backend (tenancy.js) quanto o frontend (app.js)
   aplicam a escala estrita: Dono > Admin > Moderador > Membro > Freelancer,
   permitindo editar apenas a própria agenda (exceto freelancer) e a de
   quem está estritamente abaixo na hierarquia.
   ─────────────────────────────────────────────────────────────── */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createTenancy, ROLES, ROLE_RANK, roleRank, canManageSchedule } = require('../tenancy');

const LEVELS = ['owner', 'admin', 'mod', 'equipe', 'free'];

function expectedCanEdit(actorRole, targetRole, sameUser) {
  if (actorRole === 'free') return false;
  if (sameUser) return true;
  if (actorRole === 'equipe') return false;
  return ROLE_RANK[actorRole] > ROLE_RANK[targetRole];
}

test('tenancy.canManageSchedule aplica hierarquia estrita em toda a matriz 5x5', () => {
  const raw = {
    organizations: [{ id: 'org1', name: 'Org 1', status: 'active' }],
    workspaces: [{ id: 'ws1', orgId: 'org1', name: 'Geral' }],
    users: [
      { id: 'u-owner', name: 'Dono' },
      { id: 'u-admin-1', name: 'Admin 1' },
      { id: 'u-admin-2', name: 'Admin 2' },
      { id: 'u-mod-1', name: 'Mod 1' },
      { id: 'u-mod-2', name: 'Mod 2' },
      { id: 'u-eq-1', name: 'Membro 1' },
      { id: 'u-eq-2', name: 'Membro 2' },
      { id: 'u-free-1', name: 'Free 1' }
    ],
    memberships: [
      { id: 'm1', orgId: 'org1', userId: 'u-owner', role: 'owner', workspaces: ['ws1'], active: true },
      { id: 'm2', orgId: 'org1', userId: 'u-admin-1', role: 'admin', workspaces: ['ws1'], active: true },
      { id: 'm3', orgId: 'org1', userId: 'u-admin-2', role: 'admin', workspaces: ['ws1'], active: true },
      { id: 'm4', orgId: 'org1', userId: 'u-mod-1', role: 'mod', workspaces: ['ws1'], active: true },
      { id: 'm5', orgId: 'org1', userId: 'u-mod-2', role: 'mod', workspaces: ['ws1'], active: true },
      { id: 'm6', orgId: 'org1', userId: 'u-eq-1', role: 'equipe', workspaces: ['ws1'], active: true },
      { id: 'm7', orgId: 'org1', userId: 'u-eq-2', role: 'equipe', workspaces: ['ws1'], active: true },
      { id: 'm8', orgId: 'org1', userId: 'u-free-1', role: 'free', workspaces: ['ws1'], active: true }
    ]
  };
  const tenancy = createTenancy({ getRaw: () => raw });
  raw.users.forEach(u => tenancy.attachUser(u));

  const primaryByRole = {
    owner: raw.users[0],
    admin: raw.users[1],
    mod: raw.users[3],
    equipe: raw.users[5],
    free: raw.users[7]
  };
  const peerByRole = {
    admin: raw.users[2],
    mod: raw.users[4],
    equipe: raw.users[6]
  };

  tenancy.run('org1', () => {
    assert.deepEqual(ROLES, LEVELS);
    for (const actorRole of LEVELS) {
      const actor = primaryByRole[actorRole];
      // Própria agenda
      assert.equal(
        tenancy.canManageSchedule(actor, actor),
        expectedCanEdit(actorRole, actorRole, true),
        `${actorRole} -> próprio`
      );
      // Outros usuários
      for (const targetRole of LEVELS) {
        const target = actorRole === targetRole && peerByRole[targetRole]
          ? peerByRole[targetRole]
          : primaryByRole[targetRole];
        if (target.id === actor.id) continue;
        assert.equal(
          tenancy.canManageSchedule(actor, target),
          expectedCanEdit(actorRole, targetRole, false),
          `${actorRole} -> ${targetRole}`
        );
      }
    }
  });
});

test('roleRank e canManageSchedule funcionam também com objetos sem orgRole explícito', () => {
  const owner = { id: '1', isOwner: true, isAdmin: true };
  const admin = { id: '2', isAdmin: true };
  const mod = { id: '3', isModerator: true };
  const member = { id: '4' };
  const free = { id: '5', isFreelancer: true };

  assert.equal(roleRank(owner), 4);
  assert.equal(roleRank(admin), 3);
  assert.equal(roleRank(mod), 2);
  assert.equal(roleRank(member), 1);
  assert.equal(roleRank(free), 0);

  assert.equal(canManageSchedule(owner, admin), true);
  assert.equal(canManageSchedule(admin, owner), false);
  assert.equal(canManageSchedule(admin, mod), true);
  assert.equal(canManageSchedule(mod, admin), false);
  assert.equal(canManageSchedule(mod, member), true);
  assert.equal(canManageSchedule(member, free), false);
  assert.equal(canManageSchedule(member, member), true);
  assert.equal(canManageSchedule(free, free), false);
});

test('frontend app.js canEditUserSchedule espelha a mesma hierarquia estrita', () => {
  const appPath = path.join(__dirname, '..', 'public', 'js', 'app.js');
  const src = fs.readFileSync(appPath, 'utf8');
  const m = src.match(/const SCHEDULE_ROLE_RANK = [\s\S]*?function canEditUserSchedule\(targetUserId\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'esperava encontrar SCHEDULE_ROLE_RANK / canEditUserSchedule em public/js/app.js');

  const usersList = [
    { id: 'u-owner', isOwner: true, isAdmin: true, orgRole: 'owner' },
    { id: 'u-admin-1', isOwner: false, isAdmin: true, orgRole: 'admin' },
    { id: 'u-admin-2', isOwner: false, isAdmin: true, orgRole: 'admin' },
    { id: 'u-mod-1', isOwner: false, isAdmin: false, isModerator: true, orgRole: 'mod' },
    { id: 'u-mod-2', isOwner: false, isAdmin: false, isModerator: true, orgRole: 'mod' },
    { id: 'u-eq-1', isOwner: false, isAdmin: false, isModerator: false, orgRole: 'equipe' },
    { id: 'u-eq-2', isOwner: false, isAdmin: false, isModerator: false, orgRole: 'equipe' },
    { id: 'u-free-1', isOwner: false, isAdmin: false, isFreelancer: true, orgRole: 'free' }
  ];

  const ctx = {
    me: null,
    userById: (id) => usersList.find(u => u.id === id) || null
  };
  vm.createContext(ctx);
  vm.runInContext(m[0], ctx);

  for (const actor of usersList) {
    ctx.me = actor;
    for (const target of usersList) {
      const same = actor.id === target.id;
      assert.equal(
        ctx.canEditUserSchedule(target.id),
        expectedCanEdit(actor.orgRole, target.orgRole, same),
        `UI ${actor.id} -> ${target.id}`
      );
    }
  }
});
