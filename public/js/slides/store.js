/* Estado compartilhado entre a lista e o editor. */
export const S = {
  me: null,
  workspaces: [],
  clients: [],
  projects: [],
  usersById: new Map(),
  nav: null // { toList(), toDeck(deck) } — preenchido pelo index.js
};

export const clientName = (id) => (S.clients.find(c => c.id === id) || {}).name || '';
export const projectName = (id) => (S.projects.find(p => p.id === id) || {}).name || '';
export const userName = (id) => { const u = S.usersById.get(id); return u ? (u.name || u.username || 'Alguém') : 'Alguém'; };
