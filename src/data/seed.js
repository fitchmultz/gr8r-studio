/* ---------- seed data ---------- */
import { dOff, minsAgo } from '../core/utils.js';

export function seed() {
  const members = [
    {
      id: 'm1',
      name: 'Mitch Fultz',
      email: 'fitchmultz@users.noreply.github.com',
      role: 'Owner',
      team: '',
      title: '',
      c: '#5A67D8',
      status: 'active',
      last: 0,
      tz: 'San Francisco',
    },
  ];
  const projects = [
    {
      id: 'p1',
      key: 'GS',
      name: 'Getting started',
      icon: 'sparkles',
      color: 'indigo',
      status: 'active',
      team: '',
      lead: 'm1',
      due: dOff(7),
      start: dOff(0),
      fav: false,
      members: ['m1'],
      desc: 'A short tour so the workspace feels like yours. Delete this project once your real ones are in.',
      milestones: [{ name: 'Workspace set up', date: dOff(7) }],
      last: 0,
    },
  ];
  let n = 0;
  const T = [];
  const t = (title, status, prio, due, x = {}) => {
    T.push(
      Object.assign(
        {
          id: 't' + ++n,
          key: 'GS-' + (100 + n * 3),
          project: 'p1',
          title,
          status,
          assignee: 'm1',
          priority: prio,
          due: due == null ? null : dOff(due),
          start: due == null ? null : dOff(due - (x.len || 3)),
          labels: [],
          subtasks: [],
          attachments: [],
          deps: [],
          desc: '',
          estimate: x.est || null,
          created: minsAgo(60 * 24),
          updated: minsAgo(60),
          order: n,
          fav: false,
          recur: null,
        },
        x,
      ),
    );
  };
  t('Create your first project', 'todo', 'high', 2, {
    est: '10m',
    desc: '<p>Use the <b>+</b> next to Projects in the sidebar, or press <b>P</b>. Give it a short key like WEB and a colour, then add tasks from any view.</p>',
  });
  t('Try every view', 'progress', 'medium', 4, {
    est: '15m',
    desc: '<p>Open this project and switch between <b>board, list, table, calendar, timeline and files</b>. Drag cards between columns on the board to change status.</p>',
  });
  t('Make it yours in Settings', 'todo', 'medium', 7, {
    est: '10m',
    subtasks: [
      { id: 's1', title: 'Pick light, dark or system theme', done: false },
      { id: 's2', title: 'Set density and accent colour', done: false },
      { id: 's3', title: 'Choose your home page', done: false },
    ],
  });
  t('Star the projects you check daily', 'backlog', 'low', null);
  t('Open the command palette with ⌘K', 'done', 'low', -1, { est: '2m', len: 1 });
  T.find(x => x.status === 'done').completedAt = minsAgo(45);
  return {
    ws: { name: 'Personal', url: 'personal', c: '#1D1C1A', brand: true },
    workspaces: [{ id: 'w1', name: 'Personal', c: '#1D1C1A', plan: 'Free', brand: true }],
    me: 'm1',
    members,
    teams: [],
    projects,
    tasks: T,
    comments: [],
    activity: [],
    notifs: [],
    files: [],
    events: [],
    projOrder: projects.map(p => p.id),
    savedViews: [],
    recentSearches: [],
    notifPrefs: {
      email_mention: true,
      email_assign: true,
      email_digest: true,
      email_comment: false,
      push_mention: true,
      push_assign: true,
      push_comment: true,
      push_due: true,
      mention_all: true,
      assign_self: true,
    },
  };
}
