/* Pure DOM-free workspace domain rules shared by browser actions and server API. */
import { LB, PCOLORS, PICONS, PR, PSTAT, ST, STATUSES, TEAMS_SEED } from './constants.js';
import { addD, dOff, diffD, formatDateWith, isIsoDate, iso, parse, todayDate, uid } from './dates.js';
import { htmlToMarkdown, markdownToHtml, stripHtml } from './markdown.js';
import { seed } from '../data/seed.js';

export class DomainError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'DomainError';
    this.status = status;
  }
}

export const DEFAULT_PREFS = {
  theme: 'system',
  accent: 'indigo',
  side: 'comfortable',
  density: 'comfortable',
  weekStart: 1,
  dateFmt: 'MMM d',
  lang: 'English (US)',
  tz: '(GMT-07:00) Pacific Time',
  motion: 'system',
  home: 'home',
  openTasks: 'drawer',
  name: 'Mitch Fultz',
  title: '',
};

export const RECUR_DAYS = { Daily: 1, Weekly: 7, 'Every 2 weeks': 14, Monthly: 30 };

export function createDefaultState(now = Date.now()) {
  return {
    data: seed(now),
    prefs: { ...DEFAULT_PREFS },
    views: {},
    collapsed: false,
  };
}

/* ---------- lookups & resolvers ---------- */
export const findMember = (data, id) => data.members.find(m => m.id === id) || null;
export const findProject = (data, id) => data.projects.find(p => p.id === id) || null;
export const findTask = (data, id) => data.tasks.find(t => t.id === id) || null;
export const canSeeProject = (data, p, actor = data.me) => !!p && (!p.private || (p.members || []).includes(actor));
export const visibleProjectsOf = (data, actor = data.me) =>
  (data.projOrder || [])
    .map(id => findProject(data, id))
    .filter(Boolean)
    .filter(p => !p.archived && canSeeProject(data, p, actor));
export const tasksOfProject = (data, pid) => data.tasks.filter(t => t.project === pid && !t.archived);
export const allTasksOf = (data, actor = data.me) => data.tasks.filter(t => !t.archived && canSeeProject(data, findProject(data, t.project), actor));
export const commentsOfTask = (data, tid) => data.comments.filter(c => c.task === tid);
export const isTaskOverdue = (t, now = Date.now()) => !!(t.due && t.status !== 'done' && diffD(parse(t.due), todayDate(now)) < 0);

export function projectProgress(data, pid) {
  const ts = tasksOfProject(data, pid);
  if (!ts.length) return 0;
  return Math.round((ts.filter(t => t.status === 'done').length / ts.length) * 100);
}

export function ensureTeams(data) {
  if (!data.teams) data.teams = TEAMS_SEED.map(t => ({ ...t }));
  return data.teams;
}

export function resolveProject(data, ref, { includeArchived = true } = {}) {
  if (!ref) return null;
  if (typeof ref === 'object' && ref.id) return ref;
  const s = String(ref).trim();
  const upper = s.toUpperCase();
  const p = data.projects.find(x => x.id === s) || data.projects.find(x => x.key?.toUpperCase() === upper) || null;
  if (!p || (!includeArchived && p.archived)) return null;
  return p;
}

export function requireProject(data, ref, opts) {
  const p = resolveProject(data, ref, opts);
  if (!p) throw new DomainError(`Project not found: ${ref}`, 404);
  return p;
}

export function resolveTask(data, ref, { includeArchived = true } = {}) {
  if (!ref) return null;
  if (typeof ref === 'object' && ref.id) return ref;
  const s = String(ref).trim();
  const upper = s.toUpperCase();
  const t = data.tasks.find(x => x.id === s) || data.tasks.find(x => x.key?.toUpperCase() === upper) || null;
  if (!t || (!includeArchived && t.archived)) return null;
  return t;
}

export function requireTask(data, ref, opts) {
  const t = resolveTask(data, ref, opts);
  if (!t) throw new DomainError(`Task not found: ${ref}`, 404);
  return t;
}

export function resolveMember(data, ref) {
  if (ref == null || ref === '' || ref === 'none' || ref === 'unassigned') return null;
  const s = String(ref).trim();
  if (!s || s.toLowerCase() === 'none' || s.toLowerCase() === 'unassigned') return null;
  if (s.toLowerCase() === 'me') return data.me || null;
  const lower = s.toLowerCase();
  const exact =
    data.members.find(m => m.id === s) || data.members.find(m => m.email?.toLowerCase() === lower) || data.members.find(m => m.name?.toLowerCase() === lower);
  if (exact) return exact.id;
  const byFirst = data.members.filter(m => m.name?.split(/\s+/)[0]?.toLowerCase() === lower);
  if (byFirst.length === 1) return byFirst[0].id;
  throw new DomainError(`Member not found: ${ref}`, 400);
}

function validMemberId(data, id) {
  return id && findMember(data, id) ? id : null;
}

export function removeMember(data, memberOrRef) {
  const m = typeof memberOrRef === 'object' && memberOrRef?.id ? findMember(data, memberOrRef.id) : findMember(data, String(memberOrRef ?? '').trim());
  if (!m) throw new DomainError(`Member not found: ${memberOrRef}`, 404);
  if (m.id === data.me) throw new DomainError('Cannot remove workspace owner');
  data.members = data.members.filter(x => x.id !== m.id);
  for (const t of data.tasks) {
    if (t.assignee === m.id) t.assignee = null;
    for (const s of t.subtasks || []) {
      if (s.assignee === m.id) s.assignee = null;
    }
  }
  for (const p of data.projects) {
    p.members = (p.members || []).filter(id => id !== m.id);
    if (p.lead === m.id) {
      p.lead = data.me;
      if (data.me && !p.members.includes(data.me)) p.members.push(data.me);
    }
  }
  return m;
}

export function resolveSubtask(task, ref) {
  if (!task || !ref) return null;
  if (typeof ref === 'object' && ref.id) return ref;
  const s = String(ref).trim();
  return task.subtasks.find(x => x.id === s) || null;
}

export function requireSubtask(task, ref) {
  const sub = resolveSubtask(task, ref);
  if (!sub) throw new DomainError(`Subtask not found: ${ref}`, 404);
  return sub;
}

/* ---------- validators ---------- */
function validateStatus(status) {
  if (!ST[status]) throw new DomainError(`Invalid status "${status}". Expected one of: ${Object.keys(ST).join(', ')}`);
  return status;
}
function validatePriority(priority) {
  if (!PR[priority]) throw new DomainError(`Invalid priority "${priority}". Expected one of: ${Object.keys(PR).join(', ')}`);
  return priority;
}
function validateLabels(labels) {
  if (!Array.isArray(labels)) throw new DomainError('labels must be an array');
  const out = [];
  for (const raw of labels) {
    const id = String(raw).trim().toLowerCase();
    if (!LB[id]) throw new DomainError(`Invalid label "${raw}". Expected one of: ${Object.keys(LB).join(', ')}`);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}
function validateOptionalDate(val, field) {
  if (val == null || val === '') return null;
  if (!isIsoDate(val)) throw new DomainError(`Invalid ${field} "${val}". Expected YYYY-MM-DD`);
  return val;
}
function validateMilestone(m) {
  const name = String(m?.name ?? '').trim();
  const date = validateOptionalDate(m?.date, 'milestone.date');
  if (!name || !date) throw new DomainError('Each milestone requires name and YYYY-MM-DD date');
  return { name, date };
}
function validateRecur(val) {
  if (val == null || val === '' || val === 'Does not repeat' || val === 'none') return null;
  if (!RECUR_DAYS[val]) throw new DomainError(`Invalid recur "${val}". Expected one of: ${Object.keys(RECUR_DAYS).join(', ')}`);
  return val;
}
function resolveDepIds(data, projectId, selfId, deps) {
  if (!Array.isArray(deps)) throw new DomainError('deps must be an array');
  const out = [];
  for (const ref of deps) {
    const dep = requireTask(data, ref, { includeArchived: false });
    if (selfId && dep.id === selfId) throw new DomainError('A task cannot depend on itself');
    if (projectId && dep.project !== projectId) throw new DomainError(`Dependency ${dep.key} belongs to a different project`);
    if (!out.includes(dep.id)) out.push(dep.id);
  }
  return out;
}
function activeProjectDeps(data, projectId, deps = [], selfId = null) {
  const out = [];
  for (const id of deps) {
    if (selfId && id === selfId) continue;
    const dep = findTask(data, id);
    if (dep && !dep.archived && dep.project === projectId && !out.includes(dep.id)) {
      out.push(dep.id);
    }
  }
  return out;
}
function resolveDescInput(fields) {
  if (fields.descHtml !== undefined) return String(fields.descHtml ?? '');
  if (fields.descMarkdown !== undefined) return markdownToHtml(fields.descMarkdown);
  if (fields.desc !== undefined) return String(fields.desc ?? '');
  return undefined;
}

/* ---------- activity ---------- */
export function logActivity(data, verb, task = null, extra = '', opts = {}) {
  const now = opts.now ?? Date.now();
  const by = opts.by ?? data.me;
  const project = opts.projectId ?? task?.project ?? null;
  data.activity.unshift({
    id: uid('a'),
    by,
    verb,
    task: task?.id || null,
    project,
    at: now,
    extra,
  });
  if (task) task.updated = now;
}

/* ---------- projects ---------- */
export function makeProjectKey(data, name, preferredKey) {
  if (preferredKey) {
    const clean = String(preferredKey)
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
    if (clean.length < 2 || clean.length > 8) throw new DomainError('Project key must be 2–8 alphanumeric characters');
    if (data.projects.some(p => p.key.toUpperCase() === clean)) throw new DomainError(`Project key "${clean}" already exists`, 409);
    return clean;
  }
  let k = String(name || '')
    .split(/\s+/)
    .map(w => w[0] || '')
    .join('')
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 3);
  if (k.length < 2)
    k =
      String(name || '')
        .replace(/[^A-Za-z]/g, '')
        .slice(0, 3)
        .toUpperCase() || 'PRJ';
  while (data.projects.some(p => p.key === k)) k += 'X';
  return k;
}

export function createProject(data, fields = {}, opts = {}) {
  const now = opts.now ?? Date.now();
  const by = opts.by ?? data.me;
  const today = todayDate(now);
  const name = String(fields.name ?? '').trim();
  if (!name) throw new DomainError('Project name is required');
  const status = fields.status ?? 'planning';
  if (!PSTAT[status]) throw new DomainError(`Invalid project status "${status}". Expected one of: ${Object.keys(PSTAT).join(', ')}`);
  const color = fields.color ?? 'indigo';
  if (!PCOLORS[color]) throw new DomainError(`Invalid project color "${color}". Expected one of: ${Object.keys(PCOLORS).join(', ')}`);
  const icon = fields.icon ?? 'folder';
  if (!PICONS.includes(icon)) throw new DomainError(`Invalid project icon "${icon}"`);
  const lead = fields.lead !== undefined ? resolveMember(data, fields.lead) || by : by;
  const start = fields.start !== undefined ? validateOptionalDate(fields.start, 'start') : dOff(0, today);
  const due = fields.due !== undefined ? validateOptionalDate(fields.due, 'due') : dOff(30, today);
  const milestones = Array.isArray(fields.milestones) ? fields.milestones.map(validateMilestone) : [];
  const p = {
    id: fields.id || uid('p'),
    key: makeProjectKey(data, name, fields.key),
    name,
    icon,
    color,
    status,
    team: fields.team ?? '',
    lead,
    due,
    start,
    fav: !!fields.fav,
    private: !!fields.private,
    members: [...new Set([by, lead, ...(fields.members || []).map(m => resolveMember(data, m))].filter(Boolean))],
    desc: String(fields.desc ?? '').trim() || 'No description yet.',
    milestones,
    seq: typeof fields.seq === 'number' ? fields.seq : 200,
    last: 0,
  };
  data.projects.push(p);
  data.projOrder = [p.id, ...(data.projOrder || []).filter(id => id !== p.id)];
  logActivity(data, 'created project', null, '', { by, projectId: p.id, now });
  if (Array.isArray(opts.starterTasks)) {
    opts.starterTasks.forEach((title, i) =>
      createTask(
        data,
        {
          project: p.id,
          title,
          status: i === 0 ? 'todo' : 'backlog',
          assignee: i === 0 ? by : null,
          priority: i === 0 ? 'high' : 'medium',
          due: dOff(5 + i * 5, today),
          start: dOff(i * 5, today),
        },
        { by, now },
      ),
    );
  }
  return p;
}

export function updateProject(data, projectOrRef, patch = {}, opts = {}) {
  const now = opts.now ?? Date.now();
  const by = opts.by ?? data.me;
  const p = requireProject(data, projectOrRef);
  if (patch.name !== undefined) {
    const name = String(patch.name).trim();
    if (!name) throw new DomainError('Project name cannot be empty');
    p.name = name;
  }
  if (patch.desc !== undefined) p.desc = String(patch.desc);
  if (patch.icon !== undefined) {
    if (!PICONS.includes(patch.icon)) throw new DomainError(`Invalid project icon "${patch.icon}"`);
    p.icon = patch.icon;
  }
  if (patch.color !== undefined) {
    if (!PCOLORS[patch.color]) throw new DomainError(`Invalid project color "${patch.color}"`);
    p.color = patch.color;
  }
  if (patch.status !== undefined && patch.status !== p.status) {
    if (!PSTAT[patch.status]) throw new DomainError(`Invalid project status "${patch.status}". Expected one of: ${Object.keys(PSTAT).join(', ')}`);
    p.status = patch.status;
    logActivity(data, 'changed status of project', null, 'to ' + PSTAT[patch.status].name, { by, projectId: p.id, now });
  }
  if (patch.team !== undefined) p.team = String(patch.team ?? '');
  if (patch.lead !== undefined) {
    const lead = resolveMember(data, patch.lead);
    if (lead) {
      p.lead = lead;
      p.members = [...new Set([...(p.members || []), lead])];
    }
  }
  if (patch.due !== undefined) p.due = validateOptionalDate(patch.due, 'due');
  if (patch.start !== undefined) p.start = validateOptionalDate(patch.start, 'start');
  if (patch.fav !== undefined) p.fav = !!patch.fav;
  if (patch.private !== undefined) p.private = !!patch.private;
  if (patch.milestones !== undefined || patch.addMilestones !== undefined || patch.removeMilestones !== undefined) {
    let next =
      patch.milestones !== undefined
        ? (() => {
            if (!Array.isArray(patch.milestones)) throw new DomainError('milestones must be an array');
            return patch.milestones.map(validateMilestone);
          })()
        : [...(p.milestones || [])];
    if (patch.removeMilestones !== undefined) {
      if (!Array.isArray(patch.removeMilestones)) throw new DomainError('removeMilestones must be an array');
      const rm = new Set(
        patch.removeMilestones.map(s =>
          String(s ?? '')
            .trim()
            .toLowerCase(),
        ),
      );
      next = next.filter(m => !rm.has(m.name.toLowerCase()));
    }
    if (patch.addMilestones !== undefined) {
      if (!Array.isArray(patch.addMilestones)) throw new DomainError('addMilestones must be an array');
      for (const raw of patch.addMilestones) {
        const m = validateMilestone(raw);
        const idx = next.findIndex(x => x.name.toLowerCase() === m.name.toLowerCase());
        if (idx >= 0) next[idx] = m;
        else next.push(m);
      }
    }
    p.milestones = next;
  }
  if (patch.archived !== undefined && !!patch.archived !== !!p.archived) {
    p.archived = !!patch.archived;
    p.archivedAt = p.archived ? now : null;
  }
  return p;
}

export function deleteProject(data, projectOrRef) {
  const p = requireProject(data, projectOrRef);
  const taskIds = data.tasks.filter(t => t.project === p.id).map(t => t.id);
  deleteTasks(data, taskIds);
  data.projects = data.projects.filter(x => x.id !== p.id);
  data.projOrder = (data.projOrder || []).filter(id => id !== p.id);
  data.files = (data.files || []).filter(f => f.project !== p.id);
  if (Array.isArray(data.savedViews)) {
    data.savedViews = data.savedViews.filter(v => v.project !== p.id);
  }
  return p;
}

export function duplicateProject(data, projectOrRef, opts = {}) {
  const now = opts.now ?? Date.now();
  const by = opts.by ?? data.me;
  const p = requireProject(data, projectOrRef);
  const copy = createProject(
    data,
    {
      name: opts.name ?? `${p.name} copy`,
      icon: p.icon,
      color: p.color,
      status: p.status,
      team: p.team,
      lead: validMemberId(data, p.lead) || by,
      due: p.due,
      start: p.start,
      desc: p.desc,
      private: p.private,
      members: (p.members || []).filter(id => validMemberId(data, id)),
      milestones: structuredClone(p.milestones || []),
    },
    { by, now },
  );
  const srcTasks = tasksOfProject(data, p.id);
  const idMap = new Map();
  for (const src of srcTasks) {
    const dup = duplicateTask(data, src, {
      project: copy.id,
      title: src.title,
      status: 'todo',
      deps: [],
      by,
      now,
    });
    idMap.set(src.id, dup);
  }
  for (const src of srcTasks) {
    const dup = idMap.get(src.id);
    dup.deps = (src.deps || []).map(d => idMap.get(d)?.id).filter(Boolean);
  }
  return copy;
}

/* ---------- tasks ---------- */
export function nextTaskKey(data, project) {
  const prefix = project.key + '-';
  let maxSeq = project.seq || 200;
  for (const t of data.tasks) {
    if (t.project === project.id && typeof t.key === 'string' && t.key.startsWith(prefix)) {
      const n = Number(t.key.slice(prefix.length));
      if (Number.isInteger(n) && n > maxSeq) maxSeq = n;
    }
  }
  project.seq = maxSeq + 1;
  return prefix + project.seq;
}

function normalizeSubtaskInput(data, raw) {
  if (typeof raw === 'string') {
    const title = raw.trim();
    if (!title) throw new DomainError('Subtask title cannot be empty');
    return { id: uid('s'), title, done: false };
  }
  const title = String(raw?.title ?? '').trim();
  if (!title) throw new DomainError('Subtask title cannot be empty');
  const out = { id: raw.id || uid('s'), title, done: !!raw.done };
  if (raw.assignee !== undefined) out.assignee = resolveMember(data, raw.assignee);
  if (raw.due !== undefined) out.due = validateOptionalDate(raw.due, 'subtask.due');
  if (raw.note !== undefined) out.note = String(raw.note ?? '');
  return out;
}

export function normalizeTaskPrLink(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const repo = String(raw.repo ?? '').trim();
  const number = Number(raw.number);
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(number) || number <= 0) return null;
  const rawUrl = String(raw.url ?? '').trim();
  const url = /^https?:\/\/\S+$/i.test(rawUrl) ? rawUrl : `https://github.com/${repo}/pull/${number}`;
  const state = raw.merged || raw.state === 'merged' ? 'merged' : raw.state === 'closed' ? 'closed' : 'open';
  const out = {
    repo,
    number,
    title: String(raw.title ?? '').trim(),
    url,
    headRef: String(raw.headRef ?? '').trim(),
    state,
    draft: state === 'open' ? !!raw.draft : false,
    closing: raw.closing !== undefined ? !!raw.closing : true,
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
  };
  if (typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) && raw.createdAt > 0) {
    out.createdAt = raw.createdAt;
  }
  if (typeof raw.linkedSeq === 'number' && Number.isFinite(raw.linkedSeq) && raw.linkedSeq > 0) {
    out.linkedSeq = raw.linkedSeq;
  }
  if (state === 'merged' && typeof raw.mergedSeq === 'number' && Number.isFinite(raw.mergedSeq) && raw.mergedSeq > 0) {
    out.mergedSeq = raw.mergedSeq;
  }
  if (state === 'merged' && typeof raw.mergedAt === 'number' && Number.isFinite(raw.mergedAt) && raw.mergedAt > 0) {
    out.mergedAt = raw.mergedAt;
  }
  return out;
}

export function createTask(data, fields = {}, opts = {}) {
  const now = opts.now ?? Date.now();
  const by = opts.by ?? data.me;
  const p = fields.project ? requireProject(data, fields.project) : visibleProjectsOf(data, by)[0] || data.projects[0];
  if (!p) throw new DomainError('No project available for new task');
  const rawTitle = fields.title === undefined && opts.allowUntitled ? 'Untitled' : String(fields.title ?? '').trim();
  if (!rawTitle) throw new DomainError('Task title is required');
  const status = validateStatus(fields.status ?? 'todo');
  const priority = validatePriority(fields.priority ?? 'none');
  const assignee = fields.assignee !== undefined ? resolveMember(data, fields.assignee) : null;
  const due = validateOptionalDate(fields.due, 'due');
  let start = validateOptionalDate(fields.start, 'start');
  if (start && due && start > due) start = due;
  const labels = fields.labels ? validateLabels(fields.labels) : [];
  const recur = validateRecur(fields.recur);
  const subtasks = Array.isArray(fields.subtasks) ? fields.subtasks.map(s => normalizeSubtaskInput(data, s)) : [];
  const prs = Array.isArray(fields.prs) ? fields.prs.map(normalizeTaskPrLink).filter(Boolean) : [];
  const deps = fields.deps ? resolveDepIds(data, p.id, fields.id, fields.deps) : [];
  const desc = resolveDescInput(fields) ?? '';
  const maxO = Math.max(0, ...data.tasks.map(t => t.order || 0));
  const t = {
    id: fields.id || uid('t'),
    key: fields.key || nextTaskKey(data, p),
    project: p.id,
    title: rawTitle,
    status,
    assignee,
    priority,
    due,
    start,
    labels,
    subtasks,
    prs,
    attachments: Array.isArray(fields.attachments) ? fields.attachments : [],
    deps,
    desc,
    estimate: fields.estimate != null && fields.estimate !== '' ? String(fields.estimate) : null,
    created: fields.created ?? now,
    updated: fields.updated ?? now,
    order: fields.order ?? maxO + 1,
    fav: !!fields.fav,
    recur,
  };
  if (status === 'done') t.completedAt = fields.completedAt ?? now;
  if (fields.completedAt === null) t.completedAt = null;
  data.tasks.push(t);
  logActivity(data, 'created', t, '', { by, now });
  return t;
}

export function duplicateTask(data, taskOrRef, opts = {}) {
  const now = opts.now ?? Date.now();
  const by = opts.by ?? data.me;
  const src = requireTask(data, taskOrRef);
  const targetProject = requireProject(data, opts.project ?? src.project);
  const status = opts.status ?? src.status;
  const copy = createTask(
    data,
    {
      ...structuredClone(src),
      id: undefined,
      key: undefined,
      project: targetProject.id,
      title: opts.title ?? `${src.title} (copy)`,
      status,
      assignee: opts.assignee !== undefined ? opts.assignee : validMemberId(data, src.assignee),
      subtasks: (src.subtasks || []).map(s => ({
        ...structuredClone(s),
        id: uid('s'),
        assignee: validMemberId(data, s.assignee),
      })),
      prs: [],
      deps: opts.deps !== undefined ? opts.deps : activeProjectDeps(data, targetProject.id, src.deps, src.id),
      created: now,
      updated: now,
      fav: false,
      completedAt: status === 'done' ? now : null,
    },
    { by, now },
  );
  if (status !== 'done') {
    delete copy.completedAt;
    delete copy.prevStatus;
  }
  return copy;
}

export function applyTaskPatch(data, taskOrRef, rawPatch = {}, opts = {}) {
  const now = opts.now ?? Date.now();
  const by = opts.by ?? data.me;
  const fmt = opts.fmtDate || (s => formatDateWith(s, 'MMM d', false, todayDate(now)));
  const t = requireTask(data, taskOrRef);
  const patch = {};

  if (rawPatch.project !== undefined) patch.project = requireProject(data, rawPatch.project).id;
  if (rawPatch.title !== undefined) {
    const title = String(rawPatch.title).trim();
    if (!title) throw new DomainError('Task title cannot be empty');
    patch.title = title;
  }
  if (rawPatch.priority !== undefined) patch.priority = validatePriority(rawPatch.priority);
  if (rawPatch.assignee !== undefined) patch.assignee = resolveMember(data, rawPatch.assignee);
  if (rawPatch.due !== undefined) {
    patch.due = validateOptionalDate(rawPatch.due, 'due');
    const effStart = rawPatch.start !== undefined ? validateOptionalDate(rawPatch.start, 'start') : t.start;
    if (patch.due && effStart && effStart > patch.due) patch.start = patch.due;
  }
  if (rawPatch.start !== undefined && patch.start === undefined) {
    const start = validateOptionalDate(rawPatch.start, 'start');
    const effDue = patch.due !== undefined ? patch.due : t.due;
    patch.start = start && effDue && start > effDue ? effDue : start;
  }
  if (rawPatch.labels !== undefined || rawPatch.addLabels !== undefined || rawPatch.removeLabels !== undefined) {
    let next = rawPatch.labels !== undefined ? validateLabels(rawPatch.labels) : [...t.labels];
    if (rawPatch.addLabels !== undefined) {
      for (const l of validateLabels(rawPatch.addLabels)) if (!next.includes(l)) next.push(l);
    }
    if (rawPatch.removeLabels !== undefined) {
      const rm = new Set(validateLabels(rawPatch.removeLabels));
      next = next.filter(l => !rm.has(l));
    }
    patch.labels = next;
  }
  const targetProject = patch.project ?? t.project;
  if (rawPatch.deps !== undefined || rawPatch.addDeps !== undefined || rawPatch.removeDeps !== undefined) {
    let next = rawPatch.deps !== undefined ? resolveDepIds(data, targetProject, t.id, rawPatch.deps) : activeProjectDeps(data, targetProject, t.deps, t.id);
    if (rawPatch.addDeps !== undefined) {
      for (const d of resolveDepIds(data, targetProject, t.id, rawPatch.addDeps)) if (!next.includes(d)) next.push(d);
    }
    if (rawPatch.removeDeps !== undefined) {
      const rm = new Set(rawPatch.removeDeps.map(r => resolveTask(data, r)?.id || String(r).trim()));
      next = next.filter(d => !rm.has(d));
    }
    patch.deps = next;
  }
  if (rawPatch.recur !== undefined) patch.recur = validateRecur(rawPatch.recur);
  if (rawPatch.estimate !== undefined) patch.estimate = rawPatch.estimate != null && rawPatch.estimate !== '' ? String(rawPatch.estimate) : null;
  if (rawPatch.fav !== undefined) patch.fav = !!rawPatch.fav;
  if (rawPatch.order !== undefined) {
    if (typeof rawPatch.order !== 'number' || Number.isNaN(rawPatch.order)) throw new DomainError('order must be a number');
    patch.order = rawPatch.order;
  }
  if (rawPatch.subtasks !== undefined) {
    if (!Array.isArray(rawPatch.subtasks)) throw new DomainError('subtasks must be an array');
    patch.subtasks = rawPatch.subtasks.map(s => normalizeSubtaskInput(data, s));
  }
  if (rawPatch.prs !== undefined) {
    if (!Array.isArray(rawPatch.prs)) throw new DomainError('prs must be an array');
    patch.prs = rawPatch.prs.map(normalizeTaskPrLink).filter(Boolean);
  }
  const resolvedDesc = resolveDescInput(rawPatch);
  if (resolvedDesc !== undefined) patch.desc = resolvedDesc;
  else if (rawPatch.appendDesc !== undefined) {
    const extraHtml = markdownToHtml(rawPatch.appendDesc);
    if (extraHtml) patch.desc = (t.desc || '') + extraHtml;
  }
  if (rawPatch.archived !== undefined) patch.archived = !!rawPatch.archived;
  if (rawPatch.status !== undefined) patch.status = validateStatus(rawPatch.status);

  const messages = [];
  let completed = false;
  let spawned = null;
  let changed = false;

  for (const k of Object.keys(patch)) {
    const old = t[k];
    const nv = patch[k];
    if (JSON.stringify(old) === JSON.stringify(nv)) continue;
    changed = true;
    t[k] = nv;
    if (k === 'status') {
      if (nv === 'done') {
        t.completedAt = now;
        t.prevStatus = old;
        completed = true;
        logActivity(data, 'completed', t, '', { by, now });
      } else {
        if (old === 'done') t.completedAt = null;
        logActivity(data, 'moved', t, `from ${ST[old].name} to ${ST[nv].name}`, { by, now });
      }
      if (nv === 'done' && t.recur && t.due) {
        const nd = iso(addD(parse(t.due), RECUR_DAYS[t.recur] || 7));
        spawned = createTask(
          data,
          {
            ...structuredClone(t),
            id: undefined,
            key: undefined,
            status: 'todo',
            assignee: validMemberId(data, t.assignee),
            due: nd,
            start: nd,
            deps: activeProjectDeps(data, t.project, t.deps, t.id),
            subtasks: t.subtasks.map(s => ({
              ...structuredClone(s),
              id: uid('s'),
              done: false,
              assignee: validMemberId(data, s.assignee),
            })),
            completedAt: null,
            attachments: [],
            prs: [],
          },
          { by, now },
        );
        delete spawned.prevStatus;
        messages.push(`Next “${t.title}” scheduled for ${fmt(nd)}`);
      }
    } else if (k === 'assignee') logActivity(data, 'assigned', t, nv ? `to ${findMember(data, nv)?.name}` : '(unassigned)', { by, now });
    else if (k === 'priority') logActivity(data, 'changed priority of', t, `to ${PR[nv].name}`, { by, now });
    else if (k === 'due') logActivity(data, 'changed due date of', t, nv ? `to ${fmt(nv)}` : '(cleared)', { by, now });
    else if (k === 'start') logActivity(data, 'changed start date of', t, nv ? `to ${fmt(nv)}` : '(cleared)', { by, now });
    else if (k === 'project') {
      const p = requireProject(data, nv);
      t.key = nextTaskKey(data, p);
      t.deps = activeProjectDeps(data, p.id, t.deps, t.id);
      for (const other of data.tasks) {
        if (other.id !== t.id && other.project !== p.id && other.deps?.includes(t.id)) {
          other.deps = other.deps.filter(d => d !== t.id);
        }
      }
      logActivity(data, 'moved', t, `to ${p.name}`, { by, now });
    } else if (k === 'labels') logActivity(data, 'updated labels on', t, '', { by, now });
    else if (k === 'title') logActivity(data, 'renamed', t, `to “${nv}”`, { by, now });
    else if (k === 'recur') logActivity(data, 'set repeat on', t, nv ? nv.toLowerCase() : 'off', { by, now });
    else if (k === 'estimate') logActivity(data, 'estimated', t, nv || 'none', { by, now });
    else if (k === 'deps') logActivity(data, 'updated dependencies of', t, '', { by, now });
    else if (k === 'archived') {
      t.archivedAt = nv ? now : null;
      if (nv) {
        for (const other of data.tasks) {
          if (other.id !== t.id && other.deps?.includes(t.id)) {
            other.deps = other.deps.filter(d => d !== t.id);
          }
        }
      }
      logActivity(data, nv ? 'archived' : 'restored', t, '', { by, now });
    }
    t.updated = now;
  }

  return { task: t, changed, completed, spawned, messages };
}

export function deleteTasks(data, idsOrRefs) {
  const ids = idsOrRefs.map(r => resolveTask(data, r)?.id || String(r));
  const set = new Set(ids);
  const removed = data.tasks.filter(t => set.has(t.id));
  data.tasks = data.tasks.filter(t => !set.has(t.id));
  data.tasks.forEach(t => {
    t.deps = (t.deps || []).filter(d => !set.has(d));
  });
  data.comments = data.comments.filter(c => !set.has(c.task));
  if (data.files) {
    data.files = data.files.filter(f => !f.task || !set.has(f.task));
  }
  return removed;
}

/* ---------- subtasks ---------- */
export function addSubtask(data, taskOrRef, fields, opts = {}) {
  const now = opts.now ?? Date.now();
  const by = opts.by ?? data.me;
  const t = requireTask(data, taskOrRef);
  const sub = normalizeSubtaskInput(data, typeof fields === 'string' ? { title: fields } : fields);
  t.subtasks.push(sub);
  logActivity(data, 'added subtask to', t, `“${sub.title}”`, { by, now });
  return sub;
}

export function updateSubtask(data, taskOrRef, subRef, patch = {}, opts = {}) {
  const now = opts.now ?? Date.now();
  const by = opts.by ?? data.me;
  const fmt = opts.fmtDate || (s => formatDateWith(s, 'MMM d', false, todayDate(now)));
  const t = requireTask(data, taskOrRef);
  const s = requireSubtask(t, subRef);
  if (patch.title !== undefined) {
    const v = String(patch.title).trim();
    if (!v) throw new DomainError('Subtask title cannot be empty');
    if (v !== s.title) {
      s.title = v;
      t.updated = now;
    }
  }
  if (patch.done !== undefined && !!patch.done !== !!s.done) {
    s.done = !!patch.done;
    logActivity(data, s.done ? 'completed subtask on' : 'reopened subtask on', t, `“${s.title}”`, { by, now });
  }
  if (patch.assignee !== undefined) {
    const nv = resolveMember(data, patch.assignee);
    if (nv !== (s.assignee || null)) {
      s.assignee = nv;
      logActivity(data, 'assigned a subtask on', t, nv ? `to ${findMember(data, nv)?.name}` : '(unassigned)', { by, now });
    }
  }
  if (patch.due !== undefined) {
    const nv = validateOptionalDate(patch.due, 'due');
    if (nv !== (s.due || null)) {
      s.due = nv;
      logActivity(data, 'set a subtask due date on', t, nv ? fmt(nv) : '(cleared)', { by, now });
    }
  }
  if (patch.note !== undefined) {
    s.note = String(patch.note ?? '');
    t.updated = now;
  }
  return s;
}

export function removeSubtask(data, taskOrRef, subRef, opts = {}) {
  const now = opts.now ?? Date.now();
  const t = requireTask(data, taskOrRef);
  const s = requireSubtask(t, subRef);
  t.subtasks = t.subtasks.filter(x => x.id !== s.id);
  t.updated = now;
  return s;
}

export function promoteSubtask(data, taskOrRef, subRef, opts = {}) {
  const now = opts.now ?? Date.now();
  const by = opts.by ?? data.me;
  const t = requireTask(data, taskOrRef);
  const s = requireSubtask(t, subRef);
  const promoted = createTask(
    data,
    {
      title: s.title,
      project: t.project,
      status: s.done ? 'done' : 'todo',
      assignee: validMemberId(data, s.assignee || t.assignee),
      priority: t.priority,
      due: s.due || null,
      labels: [...t.labels],
      descMarkdown: s.note || '',
    },
    { by, now },
  );
  t.subtasks = t.subtasks.filter(x => x.id !== s.id);
  logActivity(data, 'converted a subtask of', t, `into ${promoted.key}`, { by, now });
  return promoted;
}

/* ---------- comments ---------- */
export function addComment(data, taskOrRef, text, opts = {}) {
  const now = opts.now ?? Date.now();
  const by = opts.by !== undefined ? resolveMember(data, opts.by) || data.me : data.me;
  const t = requireTask(data, taskOrRef);
  const txt = String(text ?? '').trim();
  if (!txt) throw new DomainError('Comment text cannot be empty');
  const c = { id: uid('c'), task: t.id, by, at: now, text: txt, re: {} };
  data.comments.push(c);
  logActivity(data, 'commented on', t, '', { by, now });
  return c;
}

export function deleteComment(data, commentId) {
  const c = data.comments.find(x => x.id === commentId);
  if (!c) throw new DomainError(`Comment not found: ${commentId}`, 404);
  data.comments = data.comments.filter(x => x.id !== commentId);
  return c;
}

export function toggleReaction(data, commentId, emoji, actor = data.me) {
  const c = data.comments.find(x => x.id === commentId);
  if (!c) throw new DomainError(`Comment not found: ${commentId}`, 404);
  c.re = c.re || {};
  const list = c.re[emoji] || [];
  c.re[emoji] = list.includes(actor) ? list.filter(x => x !== actor) : [...list, actor];
  return c;
}

/* ---------- queries & search ---------- */
export function formatTaskForApi(data, t) {
  const p = findProject(data, t.project);
  return {
    ...t,
    projectKey: p?.key || null,
    projectName: p?.name || null,
    assigneeName: findMember(data, t.assignee)?.name || null,
    depKeys: (t.deps || []).map(id => findTask(data, id)?.key).filter(Boolean),
    descMarkdown: htmlToMarkdown(t.desc),
    subtaskDoneCount: (t.subtasks || []).filter(s => s.done).length,
    subtaskCount: (t.subtasks || []).length,
    commentCount: commentsOfTask(data, t.id).length,
  };
}

export function formatProjectForApi(data, p, now = Date.now()) {
  const ts = tasksOfProject(data, p.id);
  const doneCount = ts.filter(t => t.status === 'done').length;
  return {
    ...p,
    leadName: findMember(data, p.lead)?.name || null,
    taskCount: ts.length,
    openCount: ts.length - doneCount,
    doneCount,
    overdueCount: ts.filter(t => isTaskOverdue(t, now)).length,
    progress: ts.length ? Math.round((doneCount / ts.length) * 100) : 0,
  };
}

export function queryTasks(data, filters = {}, opts = {}) {
  const now = opts.now ?? Date.now();
  const actor = opts.actor ?? data.me;
  const today = todayDate(now);
  const archivedRaw = typeof filters.archived === 'string' ? filters.archived.trim().toLowerCase() : filters.archived;
  const includeArchived = archivedRaw === true || archivedRaw === 'true' || archivedRaw === '1' || archivedRaw === 'all';
  const targetProject = filters.project ? requireProject(data, filters.project) : null;
  let out = data.tasks.filter(t => {
    if (!includeArchived && t.archived) return false;
    const p = findProject(data, t.project);
    if (targetProject) {
      if (t.project !== targetProject.id) return false;
    } else if (!includeArchived && p?.archived) {
      return false;
    }
    if (!canSeeProject(data, p, actor)) return false;
    return true;
  });

  if (filters.status) {
    const vals = String(filters.status)
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
    out = out.filter(t => vals.some(v => (v === 'open' ? t.status !== 'done' : t.status === v)));
  }
  if (filters.priority) {
    const vals = new Set(
      String(filters.priority)
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean),
    );
    out = out.filter(t => vals.has(t.priority));
  }
  if (filters.assignee) {
    const raw = String(filters.assignee).trim();
    if (raw === 'none' || raw === 'unassigned') out = out.filter(t => !t.assignee);
    else {
      const mid = resolveMember(data, raw);
      out = out.filter(t => t.assignee === mid);
    }
  }
  if (filters.label) {
    const vals = String(filters.label)
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
    out = out.filter(t => vals.some(v => (t.labels || []).includes(v)));
  }
  if (filters.due) {
    const v = String(filters.due).trim().toLowerCase();
    out = out.filter(t => {
      if (v === 'nodate' || v === 'none') return !t.due;
      if (!t.due) return false;
      const n = diffD(parse(t.due), today);
      if (v === 'overdue') return isTaskOverdue(t, now);
      if (v === 'today') return t.status !== 'done' && n === 0;
      if (v === 'week') return t.status !== 'done' && n >= 0 && n <= 7;
      if (isIsoDate(v)) return t.due === v;
      return true;
    });
  }
  if (filters.q) {
    const q = String(filters.q).trim().toLowerCase();
    if (q) {
      out = out.filter(
        t =>
          t.key.toLowerCase().includes(q) ||
          t.title.toLowerCase().includes(q) ||
          stripHtml(t.desc).toLowerCase().includes(q) ||
          (t.prs || []).some(
            pr =>
              `${pr.repo}#${pr.number}`.toLowerCase().includes(q) || (pr.title || '').toLowerCase().includes(q) || (pr.headRef || '').toLowerCase().includes(q),
          ),
      );
    }
  }

  const sortField = filters.sort || 'manual';
  const dir = filters.dir === 'desc' || filters.dir === -1 || filters.dir === '-1' ? -1 : 1;
  const keyFn =
    {
      manual: t => t.order ?? 0,
      title: t => t.title.toLowerCase(),
      due: t => t.due || '9999',
      start: t => t.start || '9999',
      priority: t => -PR[t.priority || 'none'].w,
      status: t => STATUSES.findIndex(x => x.id === t.status),
      assignee: t => findMember(data, t.assignee)?.name || 'zzz',
      created: t => -t.created,
      updated: t => -t.updated,
      key: t => t.key,
    }[sortField] || (t => t.order ?? 0);

  out = [...out].sort((a, b) => {
    const ka = keyFn(a);
    const kb = keyFn(b);
    return (ka > kb ? 1 : ka < kb ? -1 : 0) * dir;
  });

  if (filters.limit != null && filters.limit !== '') {
    const lim = Math.max(1, Number(filters.limit) || 50);
    out = out.slice(0, lim);
  }
  return out;
}

export function searchWorkspace(data, query, opts = {}) {
  const actor = opts.actor ?? data.me;
  const q = String(query || '')
    .trim()
    .toLowerCase();
  if (!q) return { tasks: [], projects: [], people: [], files: [], comments: [] };
  const has = s => (s || '').toLowerCase().includes(q);
  return {
    tasks: allTasksOf(data, actor)
      .filter(
        t =>
          has(t.title) || has(t.key) || has(stripHtml(t.desc)) || (t.prs || []).some(pr => has(`${pr.repo}#${pr.number}`) || has(pr.title) || has(pr.headRef)),
      )
      .slice(0, 30),
    projects: visibleProjectsOf(data, actor).filter(p => has(p.name) || has(p.key) || has(p.desc)),
    people: (data.members || []).filter(m => has(m.name) || has(m.email) || has(m.title)),
    files: (data.files || []).filter(f => has(f.name) && canSeeProject(data, findProject(data, f.project), actor)),
    comments: (data.comments || []).filter(c => {
      if (!has(c.text)) return false;
      const t = findTask(data, c.task);
      return !!t && canSeeProject(data, findProject(data, t.project), actor);
    }),
  };
}

/* ---------- atomic field-level workspace diff & merge ---------- */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const KEYED_DATA_LISTS = ['teams', 'workspaces', 'files', 'notifs', 'events', 'savedViews'];
const KNOWN_DATA_KEYS = new Set([
  'ws',
  'notifPrefs',
  'me',
  'recentSearches',
  'projOrder',
  'projects',
  'members',
  'tasks',
  'comments',
  'activity',
  'prWatermarks',
  ...KEYED_DATA_LISTS,
]);

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k])) return false;
  }
  return true;
}

function diffObjectMap(baseObj = {}, nextObj = {}) {
  const b = isPlainObject(baseObj) ? baseObj : {};
  const n = isPlainObject(nextObj) ? nextObj : {};
  const set = {};
  const deleted = [];
  for (const k of Object.keys(b)) {
    if (UNSAFE_KEYS.has(k)) continue;
    if (!Object.prototype.hasOwnProperty.call(n, k) || n[k] === undefined) deleted.push(k);
  }
  for (const k of Object.keys(n)) {
    if (UNSAFE_KEYS.has(k) || n[k] === undefined) continue;
    if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(b[k], n[k])) {
      set[k] = structuredClone(n[k]);
    }
  }
  return Object.keys(set).length || deleted.length ? { set, deleted } : null;
}

function applyObjectMap(targetObj, diff) {
  if (!diff) return targetObj;
  if (!isPlainObject(diff)) throw new DomainError('Invalid map patch', 400);
  const out = isPlainObject(targetObj) ? targetObj : {};
  if (Array.isArray(diff.deleted)) {
    for (const k of diff.deleted) {
      if (typeof k === 'string' && !UNSAFE_KEYS.has(k)) delete out[k];
    }
  }
  if (isPlainObject(diff.set)) {
    for (const [k, v] of Object.entries(diff.set)) {
      if (!UNSAFE_KEYS.has(k)) out[k] = structuredClone(v);
    }
  }
  return out;
}

function diffPlainFields(baseItem, nextItem, skip = new Set()) {
  const set = {};
  const deleted = [];
  for (const k of Object.keys(baseItem)) {
    if (k === 'id' || skip.has(k) || UNSAFE_KEYS.has(k)) continue;
    if (!Object.prototype.hasOwnProperty.call(nextItem, k) || nextItem[k] === undefined) deleted.push(k);
  }
  for (const k of Object.keys(nextItem)) {
    if (k === 'id' || skip.has(k) || UNSAFE_KEYS.has(k) || nextItem[k] === undefined) continue;
    if (!Object.prototype.hasOwnProperty.call(baseItem, k) || !deepEqual(baseItem[k], nextItem[k])) {
      set[k] = structuredClone(nextItem[k]);
    }
  }
  return Object.keys(set).length || deleted.length ? { set, deleted } : null;
}

function applyPlainFields(targetItem, fieldDiff, { monotonicKeys = [] } = {}) {
  if (!fieldDiff) return;
  if (!isPlainObject(fieldDiff)) throw new DomainError('Invalid field patch', 400);
  const monotonic = new Set(monotonicKeys);
  if (Array.isArray(fieldDiff.deleted)) {
    for (const k of fieldDiff.deleted) {
      if (typeof k === 'string' && k !== 'id' && !UNSAFE_KEYS.has(k)) delete targetItem[k];
    }
  }
  if (isPlainObject(fieldDiff.set)) {
    for (const [k, v] of Object.entries(fieldDiff.set)) {
      if (k === 'id' || UNSAFE_KEYS.has(k)) continue;
      if (monotonic.has(k) && typeof v === 'number' && typeof targetItem[k] === 'number') {
        targetItem[k] = Math.max(targetItem[k], v);
      } else {
        targetItem[k] = structuredClone(v);
      }
    }
  }
}

function diffKeyedList(baseArr = [], nextArr = [], diffItem = (a, b) => diffPlainFields(a, b)) {
  const bArr = Array.isArray(baseArr) ? baseArr : [];
  const nArr = Array.isArray(nextArr) ? nextArr : [];
  const baseById = new Map(bArr.filter(x => x?.id).map(x => [x.id, x]));
  const nextById = new Map(nArr.filter(x => x?.id).map(x => [x.id, x]));
  const deleted = [];
  for (const id of baseById.keys()) {
    if (!nextById.has(id)) deleted.push(id);
  }
  const created = [];
  const updated = {};
  for (const item of nArr) {
    if (!item?.id || UNSAFE_KEYS.has(item.id)) continue;
    const prev = baseById.get(item.id);
    if (!prev) {
      created.push(structuredClone(item));
    } else {
      const d = diffItem(prev, item);
      if (d) updated[item.id] = d;
    }
  }
  const defaultOrder = [...bArr.filter(x => x?.id && nextById.has(x.id)).map(x => x.id), ...created.map(x => x.id)];
  const actualOrder = nArr.filter(x => x?.id).map(x => x.id);
  const order = defaultOrder.join('\0') !== actualOrder.join('\0') ? actualOrder : null;
  if (!deleted.length && !created.length && !Object.keys(updated).length && !order) return null;
  return {
    ...(deleted.length ? { deleted } : {}),
    ...(created.length ? { created } : {}),
    ...(Object.keys(updated).length ? { updated } : {}),
    ...(order ? { order } : {}),
  };
}

function reorderByIds(list, orderIds) {
  if (!Array.isArray(orderIds) || !orderIds.length) return list;
  const byId = new Map(list.map(item => [item.id, item]));
  const seen = new Set();
  const out = [];
  for (const id of orderIds) {
    if (seen.has(id)) continue;
    const item = byId.get(id);
    if (item) {
      out.push(item);
      seen.add(id);
    }
  }
  for (const item of list) {
    if (!seen.has(item.id)) out.push(item);
  }
  return out;
}

function applyGenericKeyedList(targetArr, diff, { filterCreated, onAdjust } = {}) {
  let list = Array.isArray(targetArr) ? targetArr : [];
  if (!diff) return list;
  if (!isPlainObject(diff)) throw new DomainError('Invalid list patch', 400);
  if (Array.isArray(diff.deleted) && diff.deleted.length) {
    const rm = new Set(diff.deleted);
    list = list.filter(x => !rm.has(x.id));
  }
  if (isPlainObject(diff.updated)) {
    const byId = new Map(list.map(x => [x.id, x]));
    for (const [id, itemDiff] of Object.entries(diff.updated)) {
      if (UNSAFE_KEYS.has(id)) continue;
      const cur = byId.get(id);
      if (cur) applyPlainFields(cur, itemDiff);
      else onAdjust?.();
    }
  }
  if (Array.isArray(diff.created)) {
    const existing = new Set(list.map(x => x.id));
    for (const raw of diff.created) {
      if (!isPlainObject(raw) || typeof raw.id !== 'string' || !raw.id || existing.has(raw.id)) continue;
      if (filterCreated && !filterCreated(raw)) {
        onAdjust?.();
        continue;
      }
      list.push(structuredClone(raw));
      existing.add(raw.id);
    }
  }
  if (Array.isArray(diff.order)) list = reorderByIds(list, diff.order);
  return list;
}

const SKIP_SUBTASKS = new Set(['subtasks']);
const SKIP_REACTIONS = new Set(['re']);

function diffTaskItem(baseTask, nextTask) {
  const fields = diffPlainFields(baseTask, nextTask, SKIP_SUBTASKS);
  const subtasks = diffKeyedList(baseTask.subtasks, nextTask.subtasks);
  if (!fields && !subtasks) return null;
  return { ...(fields ? { fields } : {}), ...(subtasks ? { subtasks } : {}) };
}

function diffCommentItem(baseComment, nextComment) {
  const fields = diffPlainFields(baseComment, nextComment, SKIP_REACTIONS);
  const re = diffObjectMap(baseComment.re, nextComment.re);
  if (!fields && !re) return null;
  return { ...(fields ? { fields } : {}), ...(re ? { re } : {}) };
}

export function diffWorkspacePatch(baseState, nextState) {
  const b = baseState || {};
  const n = nextState || {};
  const bd = b.data || {};
  const nd = n.data || {};
  const patch = {};

  const projects = diffKeyedList(bd.projects, nd.projects);
  if (projects) patch.projects = projects;
  const members = diffKeyedList(bd.members, nd.members);
  if (members) patch.members = members;
  const tasks = diffKeyedList(bd.tasks, nd.tasks, diffTaskItem);
  if (tasks) patch.tasks = tasks;
  const comments = diffKeyedList(bd.comments, nd.comments, diffCommentItem);
  if (comments) patch.comments = comments;

  for (const key of KEYED_DATA_LISTS) {
    const listDiff = diffKeyedList(bd[key], nd[key]);
    if (listDiff) patch[key] = listDiff;
  }

  const baseAct = Array.isArray(bd.activity) ? bd.activity : [];
  const nextAct = Array.isArray(nd.activity) ? nd.activity : [];
  if (baseAct.length > 0 && nextAct.length === 0) {
    patch.activityCleared = true;
  } else {
    const seenAct = new Set(baseAct.map(a => a?.id).filter(Boolean));
    const added = nextAct.filter(a => a?.id && !seenAct.has(a.id)).map(a => structuredClone(a));
    if (added.length) patch.activityAdded = added;
  }

  const nextProjIds = new Set((nd.projects || []).map(p => p.id));
  const createdProjIds = (projects?.created || []).map(p => p.id);
  const expectedProjOrder = [...createdProjIds, ...(bd.projOrder || []).filter(id => nextProjIds.has(id) && !createdProjIds.includes(id))];
  const actualProjOrder = (nd.projOrder || []).filter(id => nextProjIds.has(id));
  if (expectedProjOrder.join('\0') !== actualProjOrder.join('\0')) {
    patch.projOrder = [...actualProjOrder];
  }

  const ws = diffObjectMap(bd.ws, nd.ws);
  if (ws) patch.ws = ws;
  const notifPrefs = diffObjectMap(bd.notifPrefs, nd.notifPrefs);
  if (notifPrefs) patch.notifPrefs = notifPrefs;
  if (!deepEqual(bd.me, nd.me) && nd.me !== undefined) patch.me = nd.me;
  if (!deepEqual(bd.recentSearches, nd.recentSearches) && nd.recentSearches !== undefined) {
    patch.recentSearches = structuredClone(nd.recentSearches);
  }

  const extraData = {};
  for (const k of Object.keys(nd)) {
    if (KNOWN_DATA_KEYS.has(k) || UNSAFE_KEYS.has(k)) continue;
    if (!deepEqual(bd[k], nd[k])) extraData[k] = structuredClone(nd[k]);
  }
  if (Object.keys(extraData).length) patch.extraData = extraData;

  const prefs = diffObjectMap(b.prefs, n.prefs);
  if (prefs) patch.prefs = prefs;
  const views = diffObjectMap(b.views, n.views);
  if (views) patch.views = views;
  if (Boolean(b.collapsed) !== Boolean(n.collapsed)) patch.collapsed = Boolean(n.collapsed);

  return patch;
}

export function isWorkspacePatchEmpty(patch) {
  return !isPlainObject(patch) || Object.keys(patch).length === 0;
}

export function applyWorkspacePatch(targetState, patch) {
  if (!isPlainObject(patch)) throw new DomainError('patch must be an object', 400);
  if (!isPlainObject(targetState) || !isPlainObject(targetState.data)) {
    throw new DomainError('Invalid target workspace state', 500);
  }
  const d = targetState.data;
  let rekeyed = false;

  const deletedProjIds = new Set(Array.isArray(patch.projects?.deleted) ? patch.projects.deleted : []);
  const deletedTaskIds = new Set(Array.isArray(patch.tasks?.deleted) ? patch.tasks.deleted : []);
  const createdProjIds = new Set(Array.isArray(patch.projects?.created) ? patch.projects.created.map(p => p?.id).filter(Boolean) : []);
  const willHaveProject = pid => typeof pid === 'string' && !!pid && !deletedProjIds.has(pid) && (!!findProject(d, pid) || createdProjIds.has(pid));

  // Pre-rescue tasks, files, and savedViews moved out of a project before deleteProject cascades.
  if (deletedProjIds.size) {
    if (isPlainObject(patch.tasks?.updated)) {
      for (const [tid, tDiff] of Object.entries(patch.tasks.updated)) {
        if (UNSAFE_KEYS.has(tid) || deletedTaskIds.has(tid)) continue;
        const nextPid = tDiff?.fields?.set?.project;
        const t = findTask(d, tid);
        if (t && deletedProjIds.has(t.project) && willHaveProject(nextPid)) {
          t.project = nextPid;
        }
      }
    }
    for (const key of ['files', 'savedViews']) {
      const upd = patch[key]?.updated;
      if (!isPlainObject(upd) || !Array.isArray(d[key])) continue;
      for (const item of d[key]) {
        const nextPid = upd[item?.id]?.set?.project;
        if (item && deletedProjIds.has(item.project) && willHaveProject(nextPid)) {
          item.project = nextPid;
        }
      }
    }
    // Also rescue files attached to a task that itself moved out of a deleted project.
    if (Array.isArray(d.files)) {
      for (const f of d.files) {
        if (f?.task && deletedProjIds.has(f.project)) {
          const parentTask = findTask(d, f.task);
          if (parentTask && !deletedProjIds.has(parentTask.project)) {
            f.project = parentTask.project;
          }
        }
      }
    }
  }

  // 1. Projects
  if (patch.projects !== undefined) {
    if (!isPlainObject(patch.projects)) throw new DomainError('Invalid projects patch', 400);
    if (Array.isArray(patch.projects.deleted)) {
      for (const pid of patch.projects.deleted) {
        if (findProject(d, pid)) deleteProject(d, pid);
      }
    }
    if (isPlainObject(patch.projects.updated)) {
      for (const [pid, pDiff] of Object.entries(patch.projects.updated)) {
        if (UNSAFE_KEYS.has(pid)) continue;
        const p = findProject(d, pid);
        if (!p) {
          rekeyed = true;
          continue;
        }
        applyPlainFields(p, pDiff, { monotonicKeys: ['seq'] });
        if (d.projects.some(other => other.id !== p.id && other.key?.toUpperCase() === String(p.key || '').toUpperCase())) {
          p.key = makeProjectKey(d, p.name);
          rekeyed = true;
        }
      }
    }
    if (Array.isArray(patch.projects.created)) {
      for (const raw of patch.projects.created) {
        if (!isPlainObject(raw) || typeof raw.id !== 'string' || !raw.id || findProject(d, raw.id)) continue;
        const p = structuredClone(raw);
        if (!p.key || d.projects.some(other => other.key?.toUpperCase() === String(p.key).toUpperCase())) {
          p.key = makeProjectKey(d, p.name || 'Project');
          p.seq = 200;
          rekeyed = true;
        }
        d.projects.push(p);
        d.projOrder = [p.id, ...(d.projOrder || []).filter(id => id !== p.id)];
      }
    }
    if (Array.isArray(patch.projects.order)) d.projects = reorderByIds(d.projects, patch.projects.order);
  }

  // 2. Members
  if (patch.members !== undefined) {
    if (!isPlainObject(patch.members)) throw new DomainError('Invalid members patch', 400);
    if (Array.isArray(patch.members.deleted)) {
      for (const mid of patch.members.deleted) {
        if (mid === d.me) rekeyed = true;
        else if (findMember(d, mid)) removeMember(d, mid);
      }
    }
    d.members = applyGenericKeyedList(
      d.members,
      { ...patch.members, deleted: [] },
      {
        onAdjust: () => {
          rekeyed = true;
        },
      },
    );
  }

  // 3. Tasks & nested subtasks
  if (patch.tasks !== undefined) {
    if (!isPlainObject(patch.tasks)) throw new DomainError('Invalid tasks patch', 400);
    if (Array.isArray(patch.tasks.deleted) && patch.tasks.deleted.length) {
      const existingIds = patch.tasks.deleted.filter(id => !!findTask(d, id));
      if (existingIds.length) deleteTasks(d, existingIds);
    }
    if (isPlainObject(patch.tasks.updated)) {
      for (const [tid, tDiff] of Object.entries(patch.tasks.updated)) {
        if (UNSAFE_KEYS.has(tid) || !isPlainObject(tDiff)) continue;
        const t = findTask(d, tid);
        if (!t) {
          rekeyed = true;
          continue;
        }
        if (tDiff.fields) {
          if (!isPlainObject(tDiff.fields)) throw new DomainError('Invalid task fields patch', 400);
          const nextProjId = tDiff.fields.set?.project;
          if (nextProjId !== undefined && !findProject(d, nextProjId)) {
            rekeyed = true;
            const clonedFields = structuredClone(tDiff.fields);
            if (isPlainObject(clonedFields.set)) {
              delete clonedFields.set.project;
              delete clonedFields.set.key;
            }
            applyPlainFields(t, clonedFields, { monotonicKeys: ['updated'] });
          } else {
            applyPlainFields(t, tDiff.fields, { monotonicKeys: ['updated'] });
          }
          const p = findProject(d, t.project);
          if (p && (!t.key || typeof t.key !== 'string' || !t.key.startsWith(p.key + '-') || d.tasks.some(other => other.id !== t.id && other.key === t.key))) {
            t.key = nextTaskKey(d, p);
            rekeyed = true;
          } else if (p && typeof t.key === 'string' && t.key.startsWith(p.key + '-')) {
            const num = Number(t.key.slice(p.key.length + 1));
            if (Number.isInteger(num) && num > (p.seq || 200)) p.seq = num;
          }
        }
        if (tDiff.subtasks) {
          t.subtasks = applyGenericKeyedList(t.subtasks || [], tDiff.subtasks, {
            onAdjust: () => {
              rekeyed = true;
            },
          });
        }
      }
    }
    if (Array.isArray(patch.tasks.created)) {
      for (const raw of patch.tasks.created) {
        if (!isPlainObject(raw) || typeof raw.id !== 'string' || !raw.id || findTask(d, raw.id)) continue;
        const p = findProject(d, raw.project);
        if (!p) {
          rekeyed = true;
          continue;
        }
        const t = structuredClone(raw);
        t.subtasks = Array.isArray(t.subtasks) ? t.subtasks : [];
        if (!t.key || typeof t.key !== 'string' || !t.key.startsWith(p.key + '-') || d.tasks.some(other => other.key === t.key)) {
          t.key = nextTaskKey(d, p);
          rekeyed = true;
        } else if (typeof t.key === 'string' && t.key.startsWith(p.key + '-')) {
          const num = Number(t.key.slice(p.key.length + 1));
          if (Number.isInteger(num) && num > (p.seq || 200)) p.seq = num;
        }
        d.tasks.push(t);
      }
    }
    if (Array.isArray(patch.tasks.order)) d.tasks = reorderByIds(d.tasks, patch.tasks.order);
    for (const t of d.tasks) {
      const rawDeps = Array.isArray(t.deps) ? t.deps : [];
      const nextDeps = activeProjectDeps(d, t.project, rawDeps, t.id);
      if (!deepEqual(rawDeps, nextDeps)) rekeyed = true;
      t.deps = nextDeps;
    }
  }

  // Ensure member references across surviving tasks/projects remain valid if a member was concurrently removed.
  for (const t of d.tasks) {
    if (t.assignee && !findMember(d, t.assignee)) {
      t.assignee = null;
      rekeyed = true;
    }
    for (const s of t.subtasks || []) {
      if (s.assignee && !findMember(d, s.assignee)) {
        s.assignee = null;
        rekeyed = true;
      }
    }
  }
  for (const p of d.projects) {
    if (Array.isArray(p.members)) {
      const cleanMembers = p.members.filter(id => !!findMember(d, id));
      if (cleanMembers.length !== p.members.length) {
        p.members = cleanMembers;
        rekeyed = true;
      }
    }
    if (p.lead && !findMember(d, p.lead)) {
      p.lead = d.me;
      if (d.me && Array.isArray(p.members) && !p.members.includes(d.me)) p.members.push(d.me);
      rekeyed = true;
    }
  }

  // 4. Comments & emoji reactions
  if (patch.comments !== undefined) {
    if (!isPlainObject(patch.comments)) throw new DomainError('Invalid comments patch', 400);
    if (Array.isArray(patch.comments.deleted) && patch.comments.deleted.length) {
      const rm = new Set(patch.comments.deleted);
      d.comments = (d.comments || []).filter(c => !rm.has(c.id));
    }
    if (isPlainObject(patch.comments.updated)) {
      const byId = new Map((d.comments || []).map(c => [c.id, c]));
      for (const [cid, cDiff] of Object.entries(patch.comments.updated)) {
        if (UNSAFE_KEYS.has(cid) || !isPlainObject(cDiff)) continue;
        const c = byId.get(cid);
        if (!c) {
          rekeyed = true;
          continue;
        }
        if (cDiff.fields) applyPlainFields(c, cDiff.fields);
        if (cDiff.re) c.re = applyObjectMap(c.re || {}, cDiff.re);
      }
    }
    if (Array.isArray(patch.comments.created)) {
      const existing = new Set((d.comments || []).map(c => c.id));
      for (const raw of patch.comments.created) {
        if (!isPlainObject(raw) || typeof raw.id !== 'string' || !raw.id || existing.has(raw.id)) continue;
        if (!findTask(d, raw.task)) {
          rekeyed = true;
          continue;
        }
        d.comments.push(structuredClone(raw));
        existing.add(raw.id);
      }
    }
    if (Array.isArray(patch.comments.order)) d.comments = reorderByIds(d.comments, patch.comments.order);
  }

  // 5. Generic keyed lists
  for (const key of KEYED_DATA_LISTS) {
    if (patch[key] === undefined) continue;
    d[key] = applyGenericKeyedList(d[key], patch[key], {
      filterCreated: raw => (!raw.project || !!findProject(d, raw.project)) && (!raw.task || !!findTask(d, raw.task)),
      onAdjust: () => {
        rekeyed = true;
      },
    });
  }

  // 6. Activity
  if (patch.activityCleared) d.activity = [];
  if (Array.isArray(patch.activityAdded) && patch.activityAdded.length) {
    const existing = new Set((d.activity || []).map(a => a?.id).filter(Boolean));
    const merged = [...(d.activity || [])];
    for (const raw of patch.activityAdded) {
      if (!isPlainObject(raw) || typeof raw.id !== 'string' || !raw.id || existing.has(raw.id)) continue;
      merged.push(structuredClone(raw));
      existing.add(raw.id);
    }
    merged.sort((a, b) => (b.at || 0) - (a.at || 0));
    d.activity = merged;
  }

  // 7. Project sidebar order
  if (Array.isArray(patch.projOrder)) {
    const valid = new Set(d.projects.map(p => p.id));
    const seen = new Set();
    const ordered = [];
    for (const id of patch.projOrder) {
      if (valid.has(id) && !seen.has(id)) {
        ordered.push(id);
        seen.add(id);
      }
    }
    for (const p of d.projects) {
      if (!seen.has(p.id)) ordered.push(p.id);
    }
    d.projOrder = ordered;
  }

  // 8. Maps & scalars
  if (patch.ws) d.ws = applyObjectMap(d.ws, patch.ws);
  if (patch.notifPrefs) d.notifPrefs = applyObjectMap(d.notifPrefs, patch.notifPrefs);
  if (patch.me !== undefined) {
    if (findMember(d, patch.me)) d.me = patch.me;
    else rekeyed = true;
  }
  if (Array.isArray(patch.recentSearches)) d.recentSearches = structuredClone(patch.recentSearches);
  if (isPlainObject(patch.extraData)) {
    for (const [k, v] of Object.entries(patch.extraData)) {
      if (!KNOWN_DATA_KEYS.has(k) && !UNSAFE_KEYS.has(k)) d[k] = structuredClone(v);
    }
  }
  if (patch.prefs) targetState.prefs = applyObjectMap(targetState.prefs, patch.prefs);
  if (patch.views) targetState.views = applyObjectMap(targetState.views, patch.views);
  if (patch.collapsed !== undefined) targetState.collapsed = Boolean(patch.collapsed);

  return { state: targetState, rekeyed };
}

/* =====================================================================
   GITHUB PULL REQUEST AUTO-LINKING
   ===================================================================== */
function parseTimestampMs(val) {
  if (typeof val === 'number' && Number.isFinite(val) && val > 0) return val;
  if (typeof val === 'string' && val.trim()) {
    const ms = Date.parse(val);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return 0;
}

function stripCodeAndComments(markdown) {
  return String(markdown ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/(?:```|~~~)[\s\S]*?(?:```|~~~)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
}

function parseStackPart(title) {
  const m = /\((\d+)\s*(?:\/|of)\s*(\d+)\)/i.exec(String(title ?? ''));
  if (!m) return null;
  const index = Number(m[1]);
  const total = Number(m[2]);
  if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || total < 2 || index > total) return null;
  return { index, total };
}

export function normalizeIncomingPullRequest(raw) {
  if (!isPlainObject(raw)) throw new DomainError('Pull request payload must be an object', 400);
  const pr = isPlainObject(raw.pull_request) ? raw.pull_request : raw;
  const repo = String(
    raw.repo ?? pr.repo ?? raw.repository?.full_name ?? raw.repository?.nameWithOwner ?? pr.repository?.nameWithOwner ?? pr.base?.repo?.full_name ?? '',
  ).trim();
  const number = Number(pr.number ?? raw.number);
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(number) || number <= 0) {
    throw new DomainError('Pull request requires valid repo ("owner/name") and positive integer number', 400);
  }
  const stateRaw = String(pr.state ?? raw.state ?? 'open')
    .trim()
    .toLowerCase();
  const merged = Boolean(pr.merged || raw.merged || pr.mergedAt || pr.merged_at || stateRaw === 'merged');
  const state = merged ? 'merged' : stateRaw === 'closed' ? 'closed' : 'open';
  const draft = state === 'open' ? Boolean(pr.draft ?? pr.isDraft ?? raw.draft) : false;
  const rawUrl = String(pr.url && !pr.url.includes('api.github.com/') ? pr.url : pr.html_url || pr.htmlUrl || raw.url || raw.htmlUrl || '').trim();
  const url = /^https?:\/\/\S+$/i.test(rawUrl) ? rawUrl : `https://github.com/${repo}/pull/${number}`;
  const bodyProvided = pr.body !== undefined || raw.body !== undefined;
  const body = String(pr.body ?? raw.body ?? '');
  return {
    repo,
    number,
    title: String(pr.title ?? raw.title ?? '').trim(),
    body,
    bodyProvided,
    headRef: String(pr.headRef ?? pr.headRefName ?? pr.head?.ref ?? raw.headRef ?? '').trim(),
    url,
    state,
    merged,
    draft,
    updatedAt: parseTimestampMs(pr.updatedAt ?? pr.updated_at ?? raw.updatedAt),
    createdAt: parseTimestampMs(pr.createdAt ?? pr.created_at ?? raw.createdAt),
    mergedAt: parseTimestampMs(pr.mergedAt ?? pr.merged_at ?? raw.mergedAt),
  };
}

export function extractPullRequestTaskRefs(data, pr) {
  const refs = new Map();
  const keys = [...new Set((data.projects || []).map(p => p.key).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!keys.length) return refs;
  const keyAlt = keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const tokenRe = new RegExp(`(?<![A-Za-z0-9])(${keyAlt})-(\\d+)(?![A-Za-z0-9])`, 'gi');

  const record = (rawKey, closing) => {
    const t = resolveTask(data, rawKey.toUpperCase());
    if (!t) return;
    const prev = refs.get(t.id);
    refs.set(t.id, { closing: Boolean(prev?.closing || closing) });
  };

  for (const src of [pr.title, pr.headRef]) {
    for (const m of String(src ?? '').matchAll(tokenRe)) {
      record(`${m[1]}-${m[2]}`, true);
    }
  }

  if (pr.body) {
    const cleanBody = stripCodeAndComments(pr.body);
    const listChunk = `(?:(?:${keyAlt})-\\d+(?:\\s*(?:,|and|&)\\s*)?)+`;
    const closingClauseRe = new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|complete[sd]?)\\s*:?\\s+(${listChunk})`, 'gi');
    const refClauseRe = new RegExp(`\\b(?:refs?|references?|part\\s+of|relates?\\s+to|task|issue|tracks?)\\s*:?\\s+(${listChunk})`, 'gi');
    for (const clause of cleanBody.matchAll(closingClauseRe)) {
      for (const m of clause[1].matchAll(tokenRe)) record(`${m[1]}-${m[2]}`, true);
    }
    for (const clause of cleanBody.matchAll(refClauseRe)) {
      for (const m of clause[1].matchAll(tokenRe)) record(`${m[1]}-${m[2]}`, false);
    }
  }

  return refs;
}

function isIncompleteStackMerge(taskPrs, mergedLink, preExistingMergedKeys = new Set()) {
  const part = parseStackPart(mergedLink.title);
  if (!part || part.index >= part.total) return false;
  return !taskPrs.some(other => {
    if (other.state !== 'merged' || !other.closing) return false;
    const otherPart = parseStackPart(other.title);
    if (!otherPart || otherPart.total !== part.total || otherPart.index < part.total) return false;
    if (other.repo.toLowerCase() === mergedLink.repo.toLowerCase()) {
      if (other.number > mergedLink.number) return true;
      return Boolean(other.mergedAt && mergedLink.createdAt && other.mergedAt >= mergedLink.createdAt);
    }
    const otherKey = `${other.repo.toLowerCase()}#${other.number}`;
    if (mergedLink.createdAt && other.mergedAt) return other.mergedAt >= mergedLink.createdAt;
    if (!mergedLink.createdAt && other.mergedSeq && mergedLink.linkedSeq) return other.mergedSeq > mergedLink.linkedSeq;
    return !preExistingMergedKeys.has(otherKey);
  });
}

function isNewerPartialThan(partial, link) {
  if (partial.repo.toLowerCase() === link.repo.toLowerCase()) return partial.number > link.number;
  return Boolean(link.mergedAt && partial.createdAt && link.mergedAt < partial.createdAt);
}

function unsatisfiedMergedPartials(taskPrs, preExistingMergedKeys) {
  return taskPrs.filter(p => p.state === 'merged' && p.closing && isIncompleteStackMerge(taskPrs, p, preExistingMergedKeys));
}

export function syncGitHubPullRequests(data, rawInputs, opts = {}) {
  const now = opts.now ?? Date.now();
  const by = opts.by ?? data.me;
  const list = Array.isArray(rawInputs) ? rawInputs : [rawInputs];
  const normalized = list.map(normalizeIncomingPullRequest).sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
  const preExistingMergedByTask = new Map(
    (data.tasks || []).map(t => [t.id, new Set((t.prs || []).filter(p => p.state === 'merged').map(p => `${p.repo.toLowerCase()}#${p.number}`))]),
  );

  const touchedIds = new Set();
  let changed = false;

  for (const incoming of normalized) {
    const prKey = `${incoming.repo.toLowerCase()}#${incoming.number}`;
    const prevWatermark = isPlainObject(data.prWatermarks) ? data.prWatermarks[prKey] || 0 : 0;
    if (prevWatermark > 0 && incoming.updatedAt > 0 && incoming.updatedAt < prevWatermark) continue;

    const refs = extractPullRequestTaskRefs(data, incoming);
    const samePr = x => x.repo.toLowerCase() === incoming.repo.toLowerCase() && x.number === incoming.number;
    let unlinkedAny = false;

    if (incoming.bodyProvided) {
      for (const t of data.tasks) {
        if (!Array.isArray(t.prs) || !t.prs.length || refs.has(t.id)) continue;
        const prev = t.prs.find(samePr);
        if (!prev) continue;
        if (prev.updatedAt > 0 && incoming.updatedAt > 0 && incoming.updatedAt < prev.updatedAt) continue;
        t.prs = t.prs.filter(x => !samePr(x));
        t.updated = Math.max(t.updated || 0, now);
        touchedIds.add(t.id);
        changed = true;
        unlinkedAny = true;
      }
    }

    for (const [taskId, refInfo] of refs.entries()) {
      const t = findTask(data, taskId);
      if (!t) continue;
      t.prs = Array.isArray(t.prs) ? t.prs : [];
      const prev = t.prs.find(samePr) || null;
      if (prev && prev.updatedAt > 0 && incoming.updatedAt > 0 && incoming.updatedAt < prev.updatedAt) continue;

      let maxSeq = t.prs.reduce((m, x) => Math.max(m, x.linkedSeq || 0, x.mergedSeq || 0), 0);
      const linkedSeq = prev?.linkedSeq || ++maxSeq;
      const mergedSeq = incoming.state === 'merged' ? (prev?.state === 'merged' && prev?.mergedSeq) || maxSeq + 1 : undefined;

      const nextLink = normalizeTaskPrLink({
        repo: incoming.repo,
        number: incoming.number,
        title: incoming.title,
        url: incoming.url,
        headRef: incoming.headRef,
        state: incoming.state,
        draft: incoming.draft,
        closing: refInfo.closing,
        updatedAt: incoming.updatedAt,
        createdAt: incoming.createdAt || prev?.createdAt,
        linkedSeq,
        mergedSeq,
        mergedAt:
          incoming.state === 'merged'
            ? prev?.state === 'merged'
              ? prev.mergedAt || incoming.mergedAt || undefined
              : incoming.mergedAt || incoming.updatedAt || (prev?.state === 'open' ? now : undefined)
            : undefined,
      });
      if (!nextLink || deepEqual(prev, nextLink)) continue;

      const preMerged = preExistingMergedByTask.get(t.id) || new Set();
      const gainedMergedAt = nextLink.state === 'merged' && prev?.state === 'merged' && !prev.mergedAt && !!nextLink.mergedAt;
      const prevUnsatisfied = gainedMergedAt ? unsatisfiedMergedPartials(t.prs, preMerged) : [];

      const idx = t.prs.findIndex(samePr);
      if (idx >= 0) t.prs[idx] = nextLink;
      else t.prs.push(nextLink);

      const prLabel = `${nextLink.repo}#${nextLink.number}`;
      if (!prev || prev.state !== nextLink.state || prev.draft !== nextLink.draft) {
        if (nextLink.state === 'merged') logActivity(data, 'merged PR on', t, prLabel, { by, now });
        else if (nextLink.state === 'closed' && prev) logActivity(data, 'closed PR on', t, prLabel, { by, now });
        else if (!prev) logActivity(data, 'linked PR to', t, prLabel, { by, now });
        else if (prev.draft && !nextLink.draft) logActivity(data, 'marked PR ready on', t, prLabel, { by, now });
      }

      const becameOpenDraft = nextLink.state === 'open' && nextLink.draft && (!prev || prev.state !== 'open');
      const becameOpenReady =
        nextLink.state === 'open' && !nextLink.draft && (!prev || prev.state !== 'open' || prev.draft || (!prev.closing && nextLink.closing));
      const becameMerged = nextLink.state === 'merged' && (!prev || prev.state !== 'merged' || (!prev.closing && nextLink.closing));
      const becameClosedUnmerged = nextLink.state === 'closed' && prev?.state === 'open';

      if (becameOpenDraft) {
        if (t.status === 'backlog' || t.status === 'todo') applyTaskPatch(data, t, { status: 'progress' }, { by, now });
      } else if (becameOpenReady) {
        if (nextLink.closing) {
          const reopenCompleted =
            t.status === 'done' && (prev?.state === 'closed' || (nextLink.createdAt && t.completedAt && nextLink.createdAt > t.completedAt));
          if (['backlog', 'todo', 'progress'].includes(t.status) || reopenCompleted) {
            applyTaskPatch(data, t, { status: 'review' }, { by, now });
          }
        } else if (t.status === 'backlog' || t.status === 'todo') {
          applyTaskPatch(data, t, { status: 'progress' }, { by, now });
        }
      } else if (becameMerged && nextLink.closing) {
        const hasOpenPr = t.prs.some(x => x.state === 'open');
        if (!hasOpenPr) {
          const nowUnsatisfied = unsatisfiedMergedPartials(t.prs, preMerged);
          const waitingOnStack = isIncompleteStackMerge(t.prs, nextLink, preMerged) || nowUnsatisfied.some(p => isNewerPartialThan(p, nextLink));
          if (waitingOnStack) {
            if (t.status === 'backlog' || t.status === 'todo') applyTaskPatch(data, t, { status: 'progress' }, { by, now });
          } else if (t.status !== 'done') {
            applyTaskPatch(data, t, { status: 'done' }, { by, now });
          }
        }
      } else if (gainedMergedAt && nextLink.closing && prevUnsatisfied.length > 0) {
        const hasOpenPr = t.prs.some(x => x.state === 'open');
        if (!hasOpenPr) {
          const nowUnsatisfied = unsatisfiedMergedPartials(t.prs, preMerged);
          const nowKeys = new Set(nowUnsatisfied.map(p => `${p.repo.toLowerCase()}#${p.number}`));
          const newlySatisfied = prevUnsatisfied.some(p => !nowKeys.has(`${p.repo.toLowerCase()}#${p.number}`));
          if (newlySatisfied && !nowUnsatisfied.some(p => isNewerPartialThan(p, nextLink)) && t.status !== 'done') {
            applyTaskPatch(data, t, { status: 'done' }, { by, now });
          }
        }
      } else if (becameClosedUnmerged) {
        const hasReadyOpen = t.prs.some(x => x.state === 'open' && !x.draft);
        const hasMergedClosing = t.prs.some(x => x.state === 'merged' && x.closing);
        if (t.status === 'review' && !hasReadyOpen && !hasMergedClosing) {
          applyTaskPatch(data, t, { status: 'progress' }, { by, now });
        }
      }

      t.updated = Math.max(t.updated || 0, now);
      touchedIds.add(t.id);
      changed = true;
    }

    if (incoming.updatedAt > 0 && (unlinkedAny || refs.size > 0 || prevWatermark > 0)) {
      if (!isPlainObject(data.prWatermarks)) data.prWatermarks = {};
      if ((data.prWatermarks[prKey] || 0) < incoming.updatedAt) {
        data.prWatermarks[prKey] = incoming.updatedAt;
      }
    }
  }

  return {
    changed,
    updatedTasks: [...touchedIds].map(id => findTask(data, id)).filter(Boolean),
  };
}
