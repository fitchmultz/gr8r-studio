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
      out = out.filter(t => t.key.toLowerCase().includes(q) || t.title.toLowerCase().includes(q) || stripHtml(t.desc).toLowerCase().includes(q));
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
      .filter(t => has(t.title) || has(t.key) || has(stripHtml(t.desc)))
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
