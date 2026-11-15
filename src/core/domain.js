/* Pure DOM-free workspace domain rules shared by browser actions and server API. */
import { LABELS, PCOLORS, PICONS, PR, PSTAT, ST, STATUSES, TEAMS_SEED, isClosedStatus } from './constants.js';
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
export const childrenOfTask = (data, tid) => data.tasks.filter(t => !t.archived && t.parent === tid);
export const isTaskOverdue = (t, now = Date.now()) => !!(t.due && !isClosedStatus(t.status) && diffD(parse(t.due), todayDate(now)) < 0);
export const openDepsOfTask = (data, t) => (t.deps || []).map(id => findTask(data, id)).filter(d => d && !d.archived && !isClosedStatus(d.status));
export const isTaskBlocked = (data, t) => openDepsOfTask(data, t).length > 0;
export const isTaskReady = (data, t) =>
  !!t && !t.archived && !findProject(data, t.project)?.archived && (t.status === 'backlog' || t.status === 'todo') && !t.claimedBy && !isTaskBlocked(data, t);

export function projectProgress(data, pid) {
  const active = tasksOfProject(data, pid).filter(t => t.status !== 'canceled');
  if (!active.length) return 0;
  return Math.round((active.filter(t => t.status === 'done').length / active.length) * 100);
}

export function ensureTeams(data) {
  if (!data.teams) data.teams = TEAMS_SEED.map(t => ({ ...t }));
  return data.teams;
}

export function ensureLabels(data) {
  if (!Array.isArray(data.labels)) data.labels = LABELS.map(l => ({ ...l }));
  return data.labels;
}

const RESERVED_LABEL_IDS = new Set(['none', 'null', 'clear', 'all']);
const UNSAFE_OBJECT_IDS = new Set(['__proto__', 'constructor', 'prototype']);

export function slugifyLabelId(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function resolveLabelColor(raw, index = 0) {
  const palette = Object.values(PCOLORS);
  if (raw == null || String(raw).trim() === '') return palette[index % palette.length];
  const s = String(raw).trim();
  const key = s.toLowerCase();
  if (Object.hasOwn(PCOLORS, key) && typeof PCOLORS[key] === 'string') return PCOLORS[key];
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toUpperCase();
  throw new DomainError(`Invalid label color "${raw}". Expected a #RRGGBB hex code or one of: ${Object.keys(PCOLORS).join(', ')}`);
}

export function resolveLabel(data, ref) {
  if (!ref) return null;
  if (typeof ref === 'object' && ref.id) return ensureLabels(data).find(l => l.id === ref.id) || null;
  const q = String(ref).trim().toLowerCase();
  if (!q) return null;
  const list = ensureLabels(data);
  return list.find(l => l.id.toLowerCase() === q) || list.find(l => l.name.toLowerCase() === q) || null;
}

export function requireLabel(data, ref) {
  const lbl = resolveLabel(data, ref);
  if (!lbl) throw new DomainError(`Label not found: ${ref}`, 404);
  return lbl;
}

export function createLabel(data, fields = {}) {
  const list = ensureLabels(data);
  const name = String(fields.name ?? '').trim();
  if (!name) throw new DomainError('Label name is required');
  const rawSlug = slugifyLabelId(fields.id ?? name);
  const id = fields.id === undefined && UNSAFE_OBJECT_IDS.has(rawSlug) ? `label-${rawSlug}` : rawSlug;
  if (!id || RESERVED_LABEL_IDS.has(id) || UNSAFE_OBJECT_IDS.has(id)) throw new DomainError(`Invalid label id "${fields.id ?? name}"`);
  if (list.some(l => l.id.toLowerCase() === id)) throw new DomainError(`Label "${id}" already exists`, 409);
  if (list.some(l => l.name.toLowerCase() === name.toLowerCase())) throw new DomainError(`Label "${name}" already exists`, 409);
  const c = resolveLabelColor(fields.color ?? fields.c, list.length);
  const created = { id, name, c };
  list.push(created);
  return created;
}

export function updateLabel(data, ref, patch = {}) {
  const list = ensureLabels(data);
  const lbl = requireLabel(data, ref);
  if (patch.name !== undefined) {
    const name = String(patch.name).trim();
    if (!name) throw new DomainError('Label name cannot be empty');
    if (list.some(l => l.id !== lbl.id && l.name.toLowerCase() === name.toLowerCase())) {
      throw new DomainError(`Label "${name}" already exists`, 409);
    }
    lbl.name = name;
  }
  if (patch.color !== undefined || patch.c !== undefined) {
    lbl.c = resolveLabelColor(patch.color ?? patch.c);
  }
  return lbl;
}

export function scrubLabelFiltersInList(filters, validLabelIds) {
  if (!Array.isArray(filters)) return { filters, changed: false };
  let changed = false;
  const out = [];
  for (const f of filters) {
    if (f?.f === 'labels' && Array.isArray(f.v) && f.v.length > 0) {
      const clean = f.v.filter(id => validLabelIds.has(id));
      if (clean.length !== f.v.length) {
        changed = true;
        if (!clean.length) continue;
        out.push({ ...f, v: clean });
        continue;
      }
    }
    out.push(f);
  }
  return { filters: changed ? out : filters, changed };
}

export function scrubViewsLabelFilters(viewsMap, validLabelIds) {
  if (!viewsMap || typeof viewsMap !== 'object' || Array.isArray(viewsMap)) return false;
  let changed = false;
  for (const v of Object.values(viewsMap)) {
    if (v && typeof v === 'object' && Array.isArray(v.filters)) {
      const res = scrubLabelFiltersInList(v.filters, validLabelIds);
      if (res.changed) {
        v.filters = res.filters;
        changed = true;
      }
    }
  }
  return changed;
}

export function deleteLabel(data, ref, opts = {}) {
  const lbl = requireLabel(data, ref);
  data.labels = ensureLabels(data).filter(l => l.id !== lbl.id);
  const validLabelIds = new Set(data.labels.map(l => l.id));
  for (const t of data.tasks || []) {
    if (Array.isArray(t.labels) && t.labels.includes(lbl.id)) {
      t.labels = t.labels.filter(id => id !== lbl.id);
    }
  }
  for (const v of data.savedViews || []) {
    if (Array.isArray(v?.filters)) {
      const res = scrubLabelFiltersInList(v.filters, validLabelIds);
      if (res.changed) v.filters = res.filters;
    }
  }
  if (opts.views) {
    scrubViewsLabelFilters(opts.views, validLabelIds);
  }
  return lbl;
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
  for (const n of data.notifs || []) {
    if (n.by === m.id) n.by = null;
  }
  for (const f of data.files || []) {
    if (f.by === m.id) f.by = data.me;
  }
  for (const doc of data.docs || []) {
    if (doc.by === m.id) doc.by = data.me;
    if (doc.updatedBy === m.id) doc.updatedBy = data.me;
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
  const normalized =
    String(status ?? '')
      .trim()
      .toLowerCase() === 'cancelled'
      ? 'canceled'
      : status;
  if (!ST[normalized]) throw new DomainError(`Invalid status "${status}". Expected one of: ${Object.keys(ST).join(', ')}`);
  return normalized;
}
function validatePriority(priority) {
  if (!PR[priority]) throw new DomainError(`Invalid priority "${priority}". Expected one of: ${Object.keys(PR).join(', ')}`);
  return priority;
}
function validateLabels(data, labels) {
  if (!Array.isArray(labels)) throw new DomainError('labels must be an array');
  const list = ensureLabels(data);
  const out = [];
  for (const raw of labels) {
    const found = resolveLabel(data, raw);
    if (!found) {
      throw new DomainError(`Invalid label "${raw}". Expected one of: ${list.map(l => l.id).join(', ')}`);
    }
    if (!out.includes(found.id)) out.push(found.id);
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

export function isDescendantTask(data, candidateId, ancestorId) {
  if (!candidateId || !ancestorId) return false;
  if (candidateId === ancestorId) return true;
  const seen = new Set([ancestorId]);
  let cur = findTask(data, candidateId);
  while (cur && cur.parent) {
    if (cur.parent === ancestorId) return true;
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
    cur = findTask(data, cur.parent);
  }
  return false;
}

function resolveParentId(data, projectId, selfId, rawParent) {
  if (rawParent == null) return null;
  const s = typeof rawParent === 'string' ? rawParent.trim() : '';
  if (typeof rawParent === 'string' && (!s || ['none', 'null', 'clear'].includes(s.toLowerCase()))) return null;
  const pTask = requireTask(data, rawParent, { includeArchived: false });
  if (projectId && pTask.project !== projectId) {
    throw new DomainError(`Parent task ${pTask.key} belongs to a different project`);
  }
  if (selfId && isDescendantTask(data, pTask.id, selfId)) {
    throw new DomainError('Cannot set parent: a task cannot be its own parent or descendant');
  }
  return pTask.id;
}

function activeProjectParent(data, projectId, rawParentId, selfId = null) {
  if (!rawParentId) return null;
  const pTask = findTask(data, rawParentId);
  if (!pTask || pTask.archived || (projectId && pTask.project !== projectId)) return null;
  if (selfId && isDescendantTask(data, pTask.id, selfId)) return null;
  return pTask.id;
}

function resolveDescInput(fields) {
  if (fields.descHtml !== undefined) return String(fields.descHtml ?? '');
  if (fields.descMarkdown !== undefined) return markdownToHtml(fields.descMarkdown);
  if (fields.desc !== undefined) return String(fields.desc ?? '');
  return undefined;
}

export function normalizeAgentName(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/\s+/g, ' ');
  if (!s || ['none', 'null', 'clear'].includes(s.toLowerCase())) return null;
  return s;
}

/* ---------- live inbox & notifications ---------- */
export const NOTIF_TYPES = ['blocker', 'mention', 'assign', 'comment', 'update'];

export function mentionsWorkspaceOwner(data, rawText) {
  const np = data.notifPrefs || {};
  if (np.mention_all === false && !np.mention_ws && np.mention_team === false) return false;
  const stripped = stripCodeAndComments(String(rawText ?? ''));
  const tokens = [...stripped.matchAll(/(?:^|[^\w])@([a-z0-9._-]+)/gi)].map(m => m[1].replace(/[._-]+$/, '').toLowerCase()).filter(Boolean);
  if (!tokens.length) return false;
  const owner = findMember(data, data.me);
  const ownerTokens = new Set(['me', 'owner']);
  if (owner) {
    const nameParts = String(owner.name || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    for (const part of nameParts) ownerTokens.add(part);
    if (nameParts.length > 1) ownerTokens.add(nameParts.join(''));
    if (nameParts.length > 1) ownerTokens.add(nameParts.join('-'));
    const emailLocal = String(owner.email || '')
      .split('@')[0]
      .toLowerCase();
    if (emailLocal) ownerTokens.add(emailLocal);
  }
  if (np.mention_all !== false && tokens.some(tok => ownerTokens.has(tok))) return true;
  if (np.mention_ws && tokens.some(tok => tok === 'workspace' || tok === 'everyone' || tok === 'here')) return true;
  if (np.mention_team !== false && data.me) {
    const myTeamTokens = new Set(
      ensureTeams(data)
        .filter(tm => (tm.members || []).includes(data.me))
        .map(tm =>
          String(tm.name || '')
            .trim()
            .toLowerCase()
            .replace(/\s+/g, ''),
        )
        .filter(Boolean),
    );
    if (tokens.some(tok => myTeamTokens.has(tok.replace(/-/g, '')))) return true;
  }
  return false;
}

export function pushNotif(data, fields = {}, opts = {}) {
  const now = opts.now ?? Date.now();
  const type = NOTIF_TYPES.includes(fields.type) ? fields.type : 'update';
  const agent = normalizeAgentName(fields.agent ?? opts.agent);
  const by = fields.by !== undefined ? validMemberId(data, fields.by) : null;
  const taskObj = fields.task ? (typeof fields.task === 'object' ? fields.task : findTask(data, fields.task)) : null;
  const projId = fields.project ? (typeof fields.project === 'object' ? fields.project.id : fields.project) : (taskObj?.project ?? null);
  data.notifs = Array.isArray(data.notifs) ? data.notifs : [];
  const n = {
    id: uid('n'),
    type,
    by,
    ...(agent ? { agent } : {}),
    task: taskObj?.id || null,
    project: projId,
    text: String(fields.text ?? ''),
    snippet: String(fields.snippet ?? '')
      .replace(/\s+/g, ' ')
      .trim(),
    at: now,
    read: !!fields.read,
  };
  data.notifs.unshift(n);
  return n;
}

export function formatNotifForApi(data, n) {
  const t = n.task ? findTask(data, n.task) : null;
  const p = n.project ? findProject(data, n.project) : t ? findProject(data, t.project) : null;
  return {
    ...n,
    agent: n.agent || null,
    byName: n.by ? findMember(data, n.by)?.name || null : null,
    taskKey: t?.key || null,
    taskTitle: t?.title || null,
    taskStatus: t?.status || null,
    projectKey: p?.key || null,
    projectName: p?.name || null,
  };
}

export function queryInbox(data, filters = {}) {
  let list = Array.isArray(data.notifs) ? data.notifs.slice() : [];
  if (filters.project) {
    const p = requireProject(data, filters.project);
    list = list.filter(n => n.project === p.id);
  }
  if (filters.task) {
    const t = requireTask(data, filters.task);
    list = list.filter(n => n.task === t.id);
  }
  if (filters.type && filters.type !== 'all') {
    const types = String(filters.type)
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
    for (const ty of types) {
      if (!NOTIF_TYPES.includes(ty)) {
        throw new DomainError(`Invalid inbox type "${ty}". Expected one of: ${NOTIF_TYPES.join(', ')}`);
      }
    }
    const allow = new Set(types);
    list = list.filter(n => allow.has(n.type));
  }
  const unreadOnly = filters.unread === true || (typeof filters.unread === 'string' && ['1', 'true', 'yes'].includes(filters.unread.trim().toLowerCase()));
  if (unreadOnly) list = list.filter(n => !n.read);
  list.sort((a, b) => (b.at || 0) - (a.at || 0));
  const lim = Number(filters.limit);
  if (Number.isFinite(lim) && lim > 0) list = list.slice(0, lim);
  return list;
}

export function setNotifRead(data, notifId, read = true) {
  const n = (data.notifs || []).find(x => x.id === notifId);
  if (!n) throw new DomainError(`Notification not found: ${notifId}`, 404);
  n.read = !!read;
  return n;
}

export function markAllNotifsRead(data, filters = {}) {
  const targets = queryInbox(data, { ...filters, unread: true, limit: undefined });
  for (const n of targets) n.read = true;
  return targets.length;
}

export function deleteNotif(data, notifId) {
  const list = data.notifs || [];
  const idx = list.findIndex(x => x.id === notifId);
  if (idx < 0) throw new DomainError(`Notification not found: ${notifId}`, 404);
  const [removed] = list.splice(idx, 1);
  return removed;
}

/* ---------- activity ---------- */
export function logActivity(data, verb, task = null, extra = '', opts = {}) {
  const now = opts.now ?? Date.now();
  const by = opts.by ?? data.me;
  const agent = normalizeAgentName(opts.agent);
  const project = opts.projectId ?? task?.project ?? null;
  const entry = {
    id: uid('a'),
    by,
    ...(agent ? { agent } : {}),
    verb,
    task: task?.id || null,
    project,
    at: now,
    extra,
  };
  data.activity.unshift(entry);
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
  if (!Object.hasOwn(PSTAT, status)) throw new DomainError(`Invalid project status "${status}". Expected one of: ${Object.keys(PSTAT).join(', ')}`);
  const color = fields.color ?? 'indigo';
  if (!Object.hasOwn(PCOLORS, color)) throw new DomainError(`Invalid project color "${color}". Expected one of: ${Object.keys(PCOLORS).join(', ')}`);
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
    if (!Object.hasOwn(PCOLORS, patch.color)) throw new DomainError(`Invalid project color "${patch.color}"`);
    p.color = patch.color;
  }
  if (patch.status !== undefined && patch.status !== p.status) {
    if (!Object.hasOwn(PSTAT, patch.status))
      throw new DomainError(`Invalid project status "${patch.status}". Expected one of: ${Object.keys(PSTAT).join(', ')}`);
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
    if (p.archived) {
      for (const t of data.tasks) {
        if (t.project === p.id && (t.claimedBy || t.claimedAt)) {
          t.claimedBy = null;
          t.claimedAt = null;
        }
      }
    }
  }
  return p;
}

/* ---------- persisted attachments / files & project docs ---------- */
export function fileTypeFromName(name) {
  const e = String(name || '')
    .split('.')
    .pop()
    .toLowerCase();
  if (e === 'fig') return 'fig';
  if (e === 'pdf') return 'pdf';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'tgz'].includes(e)) return 'zip';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic', 'avif'].includes(e)) return 'img';
  if (['xlsx', 'xls', 'csv', 'tsv', 'numbers'].includes(e)) return 'sheet';
  if (['doc', 'docx', 'txt', 'md', 'pages', 'rtf'].includes(e)) return 'doc';
  if (['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'html', 'css', 'py', 'go', 'rs', 'sh'].includes(e)) return 'code';
  return 'other';
}

export function formatByteSize(bytes) {
  const b = Math.max(0, Number(bytes) || 0);
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${Math.round(b / 1024)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

export function buildAttachmentBlobUrl(file) {
  if (!file?.blobId) return '';
  const qp = new URLSearchParams();
  if (file.name) qp.set('name', file.name);
  if (file.mime) qp.set('mime', file.mime);
  const qs = qp.toString();
  return `/api/blobs/${file.blobId}${qs ? '?' + qs : ''}`;
}

export function attachFileRecord(data, fields = {}, opts = {}) {
  const now = opts.now ?? Date.now();
  const by = opts.by !== undefined ? resolveMember(data, opts.by) || data.me : data.me;
  const agent = normalizeAgentName(opts.agent);
  const name = String(fields.name ?? '')
    .trim()
    .replace(/[/\\]/g, '_');
  if (!name) throw new DomainError('Attachment file name is required');
  let taskObj = fields.task ? requireTask(data, fields.task) : null;
  let projObj = fields.project ? requireProject(data, fields.project) : null;
  if (!taskObj && fields.target) {
    const targetStr = String(fields.target).trim();
    if (/^[A-Z][A-Z0-9]*-\d+$/i.test(targetStr) || findTask(data, targetStr)) {
      taskObj = requireTask(data, targetStr);
    } else if (projObj) {
      const targetProj = resolveProject(data, targetStr);
      if (targetProj) {
        if (targetProj.id !== projObj.id) {
          throw new DomainError(`Project target "${targetStr}" conflicts with -p ${projObj.key}`, 400);
        }
      } else {
        taskObj = requireTask(data, targetStr);
      }
    } else {
      projObj = resolveProject(data, targetStr);
      if (!projObj) taskObj = resolveTask(data, targetStr);
      if (!projObj && !taskObj) throw new DomainError(`Task or project not found: ${targetStr}`, 404);
    }
  }
  if (!projObj && taskObj) projObj = requireProject(data, taskObj.project);
  if (!projObj) throw new DomainError('Attachment requires a project or task');
  if (taskObj && taskObj.project !== projObj.id) {
    throw new DomainError(`Task ${taskObj.key} belongs to a different project than ${projObj.key}`);
  }
  let blobId = null;
  if (fields.blobId !== undefined && fields.blobId !== null && fields.blobId !== '') {
    const bid = String(fields.blobId).trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(bid)) throw new DomainError('Invalid blobId: expected 64-char sha256 hex');
    blobId = bid;
  }
  const sizeBytes = fields.sizeBytes !== undefined ? Math.max(0, Number(fields.sizeBytes) || 0) : undefined;
  const size = fields.size ? String(fields.size) : formatByteSize(sizeBytes ?? 0);
  const mime = fields.mime ? String(fields.mime).trim() : undefined;
  const rawUrl = !blobId && fields.url && !String(fields.url).startsWith('blob:') ? String(fields.url) : undefined;
  const url = blobId ? buildAttachmentBlobUrl({ blobId, name, mime }) : rawUrl;
  const id = fields.id || uid('f');
  const base = {
    id,
    name,
    type: fields.type || fileTypeFromName(name),
    size,
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...(mime ? { mime } : {}),
    ...(blobId ? { blobId } : {}),
    ...(url ? { url } : {}),
    by,
    ...(agent ? { agent } : {}),
    at: now,
  };
  data.files = Array.isArray(data.files) ? data.files : [];
  const fileRec = { ...base, project: projObj.id, task: taskObj?.id || null };
  data.files.unshift(fileRec);
  if (taskObj) {
    taskObj.attachments = Array.isArray(taskObj.attachments) ? taskObj.attachments : [];
    taskObj.attachments.push({ ...base });
    logActivity(data, 'added a file to', taskObj, name, { by, agent, now });
  } else {
    logActivity(data, 'uploaded file', null, name, { by, agent, projectId: projObj.id, now });
  }
  return fileRec;
}

export function formatFileForApi(data, f) {
  const p = f.project ? findProject(data, f.project) : null;
  const t = f.task ? findTask(data, f.task) : null;
  return {
    ...f,
    url: f.blobId ? buildAttachmentBlobUrl(f) : f.url && !String(f.url).startsWith('blob:') ? f.url : null,
    byName: f.by ? findMember(data, f.by)?.name || null : null,
    projectKey: p?.key || null,
    projectName: p?.name || null,
    taskKey: t?.key || null,
    taskTitle: t?.title || null,
  };
}

export function queryFiles(data, filters = {}) {
  let list = Array.isArray(data.files) ? data.files.slice() : [];
  if (filters.project) {
    const p = requireProject(data, filters.project);
    list = list.filter(f => f.project === p.id);
  }
  if (filters.task) {
    const t = requireTask(data, filters.task);
    list = list.filter(f => f.task === t.id);
  }
  if (filters.type && filters.type !== 'all') {
    list = list.filter(f => f.type === filters.type);
  }
  list.sort((a, b) => (b.at || 0) - (a.at || 0));
  return list;
}

export function deleteWorkspaceFile(data, fileId, opts = {}) {
  const now = opts.now ?? Date.now();
  const by = opts.by ?? data.me;
  const agent = normalizeAgentName(opts.agent);
  const list = data.files || [];
  const idx = list.findIndex(x => x.id === fileId);
  if (idx < 0) throw new DomainError(`File not found: ${fileId}`, 404);
  const [removed] = list.splice(idx, 1);
  if (removed.task) {
    const t = findTask(data, removed.task);
    if (t && Array.isArray(t.attachments)) {
      t.attachments = t.attachments.filter(a => a.id !== removed.id && (a.id || a.name !== removed.name));
      logActivity(data, 'removed a file from', t, removed.name, { by, agent, now });
    }
  }
  return removed;
}

export function slugifyDocSlug(raw) {
  return (
    String(raw ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'doc'
  );
}

function uniqueDocSlug(data, projectId, desired, excludeId = null) {
  const base = slugifyDocSlug(desired);
  const safeBase = UNSAFE_OBJECT_IDS.has(base) ? `doc-${base}` : base;
  const docs = (data.docs || []).filter(d => d.project === projectId && d.id !== excludeId);
  if (!docs.some(d => d.slug === safeBase)) return safeBase;
  let i = 2;
  while (docs.some(d => d.slug === `${safeBase}-${i}`)) i++;
  return `${safeBase}-${i}`;
}

export function docsOfProject(data, pid) {
  return (data.docs || [])
    .filter(d => d.project === pid)
    .slice()
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updated || 0) - (a.updated || 0));
}

function resolveDocBodyInput(fields) {
  if (fields.bodyMarkdown !== undefined) return String(fields.bodyMarkdown ?? '');
  if (fields.body !== undefined) return String(fields.body ?? '');
  if (fields.bodyHtml !== undefined) return htmlToMarkdown(fields.bodyHtml);
  return undefined;
}

export function resolveDoc(data, ref, projectRef = null) {
  if (!ref) return null;
  const docs = data.docs || [];
  if (typeof ref === 'object' && ref.id) return docs.find(d => d.id === ref.id) || null;
  const s = String(ref).trim();
  const projFilter = projectRef ? requireProject(data, projectRef).id : null;
  const scoped = projFilter ? docs.filter(d => d.project === projFilter) : docs;
  const byId = scoped.find(d => d.id === s);
  if (byId) return byId;
  const lower = s.toLowerCase();
  const slugMatches = scoped.filter(d => d.slug === lower);
  if (slugMatches.length === 1) return slugMatches[0];
  if (slugMatches.length > 1) {
    throw new DomainError(`Ambiguous doc reference "${ref}" across multiple projects; pass -p <project>`, 409);
  }
  const titleMatches = scoped.filter(d => d.title.toLowerCase() === lower);
  if (titleMatches.length === 1) return titleMatches[0];
  if (titleMatches.length > 1) {
    const hint = projFilter ? 'use doc id or unique slug' : 'pass -p <project> or use doc id';
    throw new DomainError(`Ambiguous doc title "${ref}"; ${hint}`, 409);
  }
  return null;
}

export function requireDoc(data, ref, projectRef = null) {
  const doc = resolveDoc(data, ref, projectRef);
  if (!doc) throw new DomainError(`Doc not found: ${ref}`, 404);
  return doc;
}

export function createDoc(data, fields = {}, opts = {}) {
  const now = opts.now ?? Date.now();
  const by = opts.by !== undefined ? resolveMember(data, opts.by) || data.me : data.me;
  const agent = normalizeAgentName(opts.agent);
  const p = fields.project ? requireProject(data, fields.project) : visibleProjectsOf(data, by)[0] || data.projects[0];
  if (!p) throw new DomainError('No project available for doc creation');
  const title = String(fields.title ?? '').trim();
  if (!title) throw new DomainError('Doc title is required');
  data.docs = Array.isArray(data.docs) ? data.docs : [];
  const rawId = fields.id ? String(fields.id).trim() : uid('doc');
  if (UNSAFE_OBJECT_IDS.has(rawId)) throw new DomainError(`Invalid doc id "${rawId}"`);
  const slug = uniqueDocSlug(data, p.id, fields.slug ?? title);
  const body = resolveDocBodyInput(fields) ?? '';
  const doc = {
    id: rawId,
    project: p.id,
    slug,
    title,
    body,
    pinned: !!fields.pinned,
    by,
    updatedBy: by,
    ...(agent ? { agent } : {}),
    created: now,
    updated: now,
  };
  data.docs.unshift(doc);
  logActivity(data, 'created doc', null, `“${title}”`, { by, agent, projectId: p.id, now });
  return doc;
}

export function updateDoc(data, ref, patch = {}, opts = {}) {
  const now = opts.now ?? Date.now();
  const by = opts.by !== undefined ? resolveMember(data, opts.by) || data.me : data.me;
  const agent = normalizeAgentName(opts.agent);
  const doc = requireDoc(data, ref, opts.project ?? patch.project);
  let changed = false;
  if (patch.title !== undefined) {
    const title = String(patch.title).trim();
    if (!title) throw new DomainError('Doc title cannot be empty');
    if (title !== doc.title) {
      doc.title = title;
      changed = true;
    }
  }
  if (patch.slug !== undefined) {
    const nextSlug = uniqueDocSlug(data, doc.project, patch.slug, doc.id);
    if (nextSlug !== doc.slug) {
      doc.slug = nextSlug;
      changed = true;
    }
  }
  const resolvedBody = resolveDocBodyInput(patch);
  if (resolvedBody !== undefined) {
    if (resolvedBody !== doc.body) {
      doc.body = resolvedBody;
      changed = true;
    }
  } else if (patch.appendBody !== undefined) {
    const extra = String(patch.appendBody ?? '').trim();
    if (extra) {
      doc.body = doc.body ? `${doc.body.replace(/\s+$/, '')}\n\n${extra}` : extra;
      changed = true;
    }
  }
  if (patch.pinned !== undefined && !!patch.pinned !== !!doc.pinned) {
    doc.pinned = !!patch.pinned;
    changed = true;
  }
  if (changed) {
    doc.updated = now;
    doc.updatedBy = by;
    if (agent) doc.agent = agent;
    logActivity(data, 'updated doc', null, `“${doc.title}”`, { by, agent, projectId: doc.project, now });
  }
  return doc;
}

export function deleteDoc(data, ref, opts = {}) {
  const now = opts.now ?? Date.now();
  const by = opts.by ?? data.me;
  const agent = normalizeAgentName(opts.agent);
  const doc = requireDoc(data, ref, opts.project);
  data.docs = (data.docs || []).filter(d => d.id !== doc.id);
  logActivity(data, 'deleted doc', null, `“${doc.title}”`, { by, agent, projectId: doc.project, now });
  return doc;
}

export function formatDocForApi(data, doc) {
  const p = findProject(data, doc.project);
  const md = String(doc.body ?? '');
  return {
    ...doc,
    body: md,
    bodyMarkdown: md,
    bodyHtml: markdownToHtml(md),
    projectKey: p?.key || null,
    projectName: p?.name || null,
    byName: doc.by ? findMember(data, doc.by)?.name || null : null,
    updatedByName: doc.updatedBy ? findMember(data, doc.updatedBy)?.name || null : null,
  };
}

export function deleteProject(data, projectOrRef) {
  const p = requireProject(data, projectOrRef);
  const taskIds = data.tasks.filter(t => t.project === p.id).map(t => t.id);
  deleteTasks(data, taskIds);
  data.projects = data.projects.filter(x => x.id !== p.id);
  data.projOrder = (data.projOrder || []).filter(id => id !== p.id);
  data.files = (data.files || []).filter(f => f.project !== p.id);
  data.docs = (data.docs || []).filter(doc => doc.project !== p.id);
  data.notifs = (data.notifs || []).filter(n => n.project !== p.id);
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
      parent: null,
      by,
      now,
    });
    idMap.set(src.id, dup);
  }
  for (const src of srcTasks) {
    const dup = idMap.get(src.id);
    dup.deps = (src.deps || []).map(d => idMap.get(d)?.id).filter(Boolean);
    dup.parent = src.parent ? idMap.get(src.parent)?.id || null : null;
  }
  for (const srcDoc of docsOfProject(data, p.id)) {
    createDoc(
      data,
      {
        project: copy.id,
        title: srcDoc.title,
        slug: srcDoc.slug,
        bodyMarkdown: srcDoc.body,
        pinned: srcDoc.pinned,
      },
      { by, now },
    );
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
  if (typeof raw.observedOpenAt === 'number' && Number.isFinite(raw.observedOpenAt) && raw.observedOpenAt > 0) {
    out.observedOpenAt = raw.observedOpenAt;
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
  if (state === 'merged' && raw.mergedAtExact) {
    out.mergedAtExact = true;
  }
  return out;
}

export function createTask(data, fields = {}, opts = {}) {
  const now = opts.now ?? Date.now();
  const by = opts.by ?? data.me;
  const agent = normalizeAgentName(opts.agent);
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
  const labels = fields.labels ? validateLabels(data, fields.labels) : [];
  const recur = validateRecur(fields.recur);
  const subtasks = Array.isArray(fields.subtasks) ? fields.subtasks.map(s => normalizeSubtaskInput(data, s)) : [];
  const prs = Array.isArray(fields.prs) ? fields.prs.map(normalizeTaskPrLink).filter(Boolean) : [];
  const deps = fields.deps ? resolveDepIds(data, p.id, fields.id, fields.deps) : [];
  const parent = fields.parent !== undefined ? resolveParentId(data, p.id, fields.id, fields.parent) : null;
  const desc = resolveDescInput(fields) ?? '';
  const maxO = Math.max(0, ...data.tasks.map(t => t.order || 0));
  const t = {
    id: fields.id || uid('t'),
    key: fields.key || nextTaskKey(data, p),
    project: p.id,
    parent,
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
  if (status === 'canceled') t.canceledAt = fields.canceledAt ?? now;
  if (fields.canceledAt === null) t.canceledAt = null;
  const initClaim = normalizeAgentName(fields.claimedBy);
  if (initClaim && !isClosedStatus(status)) {
    t.claimedBy = initClaim;
    t.claimedAt = fields.claimedAt ?? now;
  }
  data.tasks.push(t);
  logActivity(data, 'created', t, '', { by, agent, now });
  const isExternalCreate = Boolean(agent) || by !== data.me;
  if (!opts.skipNotifs) {
    if (opts.needsOwner) {
      pushNotif(data, { type: 'blocker', by, agent, task: t, text: 'needs your input on', snippet: stripHtml(t.desc) || t.title }, { now });
    } else if (isExternalCreate && !isClosedStatus(status)) {
      const descMd = htmlToMarkdown(t.desc || '');
      if (data.notifPrefs?.push_mention !== false && descMd && mentionsWorkspaceOwner(data, descMd)) {
        pushNotif(data, { type: 'mention', by, agent, task: t, text: 'mentioned you in', snippet: stripHtml(t.desc) || t.title }, { now });
      } else if (assignee && assignee === data.me && data.notifPrefs?.assign_self !== false && data.notifPrefs?.push_assign !== false) {
        pushNotif(data, { type: 'assign', by, agent, task: t, text: 'assigned you', snippet: t.title }, { now });
      }
    }
  }
  return t;
}

export function duplicateTask(data, taskOrRef, opts = {}) {
  const now = opts.now ?? Date.now();
  const by = opts.by ?? data.me;
  const agent = normalizeAgentName(opts.agent);
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
      parent: opts.parent !== undefined ? opts.parent : targetProject.id === src.project ? activeProjectParent(data, targetProject.id, src.parent, null) : null,
      created: now,
      updated: now,
      fav: false,
      claimedBy: null,
      claimedAt: null,
      completedAt: status === 'done' ? now : null,
      canceledAt: status === 'canceled' ? now : null,
    },
    { by, agent, now },
  );
  if (status !== 'done') {
    delete copy.completedAt;
  }
  if (status !== 'canceled') {
    delete copy.canceledAt;
  }
  if (!isClosedStatus(status)) delete copy.prevStatus;
  delete copy.claimedBy;
  delete copy.claimedAt;
  return copy;
}

export function applyTaskPatch(data, taskOrRef, rawPatch = {}, opts = {}) {
  const now = opts.now ?? Date.now();
  const by = opts.by ?? data.me;
  const agent = normalizeAgentName(opts.agent);
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
    let next = rawPatch.labels !== undefined ? validateLabels(data, rawPatch.labels) : [...t.labels];
    if (rawPatch.addLabels !== undefined) {
      for (const l of validateLabels(data, rawPatch.addLabels)) if (!next.includes(l)) next.push(l);
    }
    if (rawPatch.removeLabels !== undefined) {
      const rm = new Set(validateLabels(data, rawPatch.removeLabels));
      next = next.filter(l => !rm.has(l));
    }
    patch.labels = next;
  }
  const targetProject = patch.project ?? t.project;
  if (rawPatch.parent !== undefined) {
    patch.parent = resolveParentId(data, targetProject, t.id, rawPatch.parent);
  } else if (patch.project !== undefined && t.parent) {
    patch.parent = activeProjectParent(data, targetProject, t.parent, t.id);
  }
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
  if (rawPatch.claimedBy !== undefined) {
    const nextClaim = normalizeAgentName(rawPatch.claimedBy);
    const nextStatus = patch.status ?? t.status;
    const nextArchived = patch.archived ?? !!t.archived;
    if (nextClaim && (nextArchived || isClosedStatus(nextStatus) || findProject(data, patch.project ?? t.project)?.archived)) {
      throw new DomainError(`Cannot claim closed or archived task ${t.key}`, 409);
    }
    patch.claimedBy = nextClaim;
  }

  const messages = [];
  let completed = false;
  let spawned = null;
  let changed = false;
  const isExternalActor = Boolean(agent) || by !== data.me || opts.source === 'github';

  for (const k of Object.keys(patch)) {
    const old = t[k];
    const nv = patch[k];
    if (JSON.stringify(old) === JSON.stringify(nv)) continue;
    changed = true;
    t[k] = nv;
    if (k === 'status') {
      if ((isClosedStatus(nv) || nv === 'backlog' || nv === 'todo') && rawPatch.claimedBy === undefined) {
        t.claimedBy = null;
        t.claimedAt = null;
      }
      if (nv === 'done') {
        t.completedAt = now;
        t.canceledAt = null;
        if (!isClosedStatus(old)) t.prevStatus = old;
        completed = true;
        logActivity(data, 'completed', t, '', { by, agent, now });
      } else if (nv === 'canceled') {
        t.canceledAt = now;
        t.completedAt = null;
        if (!isClosedStatus(old)) t.prevStatus = old;
        logActivity(data, 'canceled', t, '', { by, agent, now });
      } else {
        if (old === 'done') t.completedAt = null;
        if (old === 'canceled') t.canceledAt = null;
        logActivity(data, 'moved', t, `from ${ST[old].name} to ${ST[nv].name}`, { by, agent, now });
      }
      if (isExternalActor && data.notifPrefs?.assign_status !== false && !opts.needsOwner) {
        if (nv === 'review') {
          pushNotif(data, { type: 'update', by, agent, task: t, text: 'moved to In Review:', snippet: opts.snippet || 'Ready for review' }, { now });
        } else if (nv === 'done') {
          pushNotif(data, { type: 'update', by, agent, task: t, text: 'completed', snippet: opts.snippet || 'Marked done' }, { now });
        } else if (nv === 'canceled') {
          pushNotif(data, { type: 'update', by, agent, task: t, text: 'canceled', snippet: opts.snippet || 'Canceled' }, { now });
        }
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
            parent: activeProjectParent(data, t.project, t.parent, null),
            subtasks: t.subtasks.map(s => ({
              ...structuredClone(s),
              id: uid('s'),
              done: false,
              assignee: validMemberId(data, s.assignee),
            })),
            completedAt: null,
            canceledAt: null,
            claimedBy: null,
            claimedAt: null,
            attachments: [],
            prs: [],
          },
          { by, agent, now, skipNotifs: true },
        );
        delete spawned.prevStatus;
        delete spawned.claimedBy;
        delete spawned.claimedAt;
        messages.push(`Next “${t.title}” scheduled for ${fmt(nd)}`);
      }
    } else if (k === 'claimedBy') {
      t.claimedAt = nv ? now : null;
      logActivity(data, nv ? 'claimed' : 'released', t, nv ? `(${nv})` : '', { by, agent: nv || agent, now });
    } else if (k === 'assignee') {
      logActivity(data, 'assigned', t, nv ? `to ${findMember(data, nv)?.name}` : '(unassigned)', { by, agent, now });
      if (
        isExternalActor &&
        !opts.skipAssignNotif &&
        nv &&
        nv === data.me &&
        data.notifPrefs?.assign_self !== false &&
        data.notifPrefs?.push_assign !== false &&
        !opts.needsOwner
      ) {
        pushNotif(data, { type: 'assign', by, agent, task: t, text: 'assigned you', snippet: t.title }, { now });
      }
    } else if (k === 'desc') {
      const prevMd = htmlToMarkdown(old || '');
      const nextMd = htmlToMarkdown(nv || '');
      const nextPlain = stripHtml(nv || '');
      if (
        isExternalActor &&
        !opts.needsOwner &&
        data.notifPrefs?.push_mention !== false &&
        !mentionsWorkspaceOwner(data, prevMd) &&
        mentionsWorkspaceOwner(data, nextMd)
      ) {
        pushNotif(data, { type: 'mention', by, agent, task: t, text: 'mentioned you in', snippet: nextPlain }, { now });
      }
    } else if (k === 'priority') logActivity(data, 'changed priority of', t, `to ${PR[nv].name}`, { by, agent, now });
    else if (k === 'due') logActivity(data, 'changed due date of', t, nv ? `to ${fmt(nv)}` : '(cleared)', { by, agent, now });
    else if (k === 'start') logActivity(data, 'changed start date of', t, nv ? `to ${fmt(nv)}` : '(cleared)', { by, agent, now });
    else if (k === 'project') {
      const p = requireProject(data, nv);
      t.key = nextTaskKey(data, p);
      t.deps = activeProjectDeps(data, p.id, t.deps, t.id);
      t.parent = activeProjectParent(data, p.id, t.parent, t.id);
      for (const n of data.notifs || []) {
        if (n.task === t.id) n.project = p.id;
      }
      for (const f of data.files || []) {
        if (f.task === t.id) f.project = p.id;
      }
      for (const other of data.tasks) {
        if (other.id !== t.id && other.project !== p.id) {
          if (other.deps?.includes(t.id)) other.deps = other.deps.filter(d => d !== t.id);
          if (other.parent === t.id) other.parent = null;
        }
      }
      logActivity(data, 'moved', t, `to ${p.name}`, { by, agent, now });
    } else if (k === 'parent') {
      logActivity(data, 'set parent of', t, nv ? `to ${findTask(data, nv)?.key}` : '(none)', { by, agent, now });
    } else if (k === 'labels') logActivity(data, 'updated labels on', t, '', { by, agent, now });
    else if (k === 'title') logActivity(data, 'renamed', t, `to “${nv}”`, { by, agent, now });
    else if (k === 'recur') logActivity(data, 'set repeat on', t, nv ? nv.toLowerCase() : 'off', { by, agent, now });
    else if (k === 'estimate') logActivity(data, 'estimated', t, nv || 'none', { by, agent, now });
    else if (k === 'deps') logActivity(data, 'updated dependencies of', t, '', { by, agent, now });
    else if (k === 'archived') {
      t.archivedAt = nv ? now : null;
      if (nv) {
        t.claimedBy = null;
        t.claimedAt = null;
        for (const other of data.tasks) {
          if (other.id !== t.id) {
            if (other.deps?.includes(t.id)) other.deps = other.deps.filter(d => d !== t.id);
            if (other.parent === t.id) other.parent = null;
          }
        }
      } else if (t.parent) {
        t.parent = activeProjectParent(data, t.project, t.parent, t.id);
      }
      logActivity(data, nv ? 'archived' : 'restored', t, '', { by, agent, now });
    }
    t.updated = now;
  }
  if (opts.needsOwner && !opts.skipNeedsOwnerNotif) {
    pushNotif(data, { type: 'blocker', by, agent, task: t, text: 'needs your input on', snippet: opts.snippet || stripHtml(t.desc) || t.title }, { now });
  }

  return { task: t, changed, completed, spawned, messages };
}

export function claimTask(data, taskOrRef, opts = {}) {
  const now = opts.now ?? Date.now();
  const by = opts.by ?? data.me;
  const agent = normalizeAgentName(opts.agent);
  if (!agent) throw new DomainError('Agent identifier is required to claim a task');
  const t = requireTask(data, taskOrRef);
  if (t.archived || findProject(data, t.project)?.archived) throw new DomainError(`Cannot claim archived task ${t.key}`, 409);
  if (opts.status !== undefined && isClosedStatus(validateStatus(opts.status))) {
    throw new DomainError('Cannot claim a task into a closed status', 400);
  }
  if (isClosedStatus(t.status) && !opts.force) {
    throw new DomainError(`Cannot claim closed task ${t.key} (${t.status})`, 409);
  }
  const openDeps = openDepsOfTask(data, t);
  if (openDeps.length && !opts.force) {
    throw new DomainError(`Task ${t.key} is blocked by ${openDeps.map(d => d.key).join(', ')}; pass --force to claim anyway`, 409);
  }
  if (t.claimedBy && t.claimedBy !== agent && !opts.force) {
    throw new DomainError(`Task ${t.key} is already claimed by ${t.claimedBy}`, 409);
  }
  const prevClaim = t.claimedBy || null;
  const patch = {};
  if (opts.status !== undefined) {
    patch.status = opts.status;
  } else if (t.status === 'backlog' || t.status === 'todo' || (isClosedStatus(t.status) && opts.force)) {
    patch.status = 'progress';
  }
  const autoAssigned = opts.assignee === undefined && !t.assignee;
  if (opts.assignee !== undefined) {
    patch.assignee = opts.assignee;
  } else if (!t.assignee) {
    patch.assignee = validMemberId(data, by) || data.me;
  }
  if (Object.keys(patch).length) {
    applyTaskPatch(data, t, patch, { by, agent, now, skipAssignNotif: autoAssigned });
  }
  t.claimedBy = agent;
  t.claimedAt = now;
  t.updated = now;
  if (prevClaim !== agent) {
    logActivity(data, prevClaim ? 'reclaimed' : 'claimed', t, prevClaim ? `from ${prevClaim}` : `(${agent})`, { by, agent, now });
  }
  return t;
}

export function releaseTask(data, taskOrRef, opts = {}) {
  const now = opts.now ?? Date.now();
  const by = opts.by ?? data.me;
  const agent = normalizeAgentName(opts.agent);
  const t = requireTask(data, taskOrRef);
  const prevClaim = t.claimedBy || null;
  t.claimedBy = null;
  t.claimedAt = null;
  if (opts.status !== undefined) {
    applyTaskPatch(data, t, { status: opts.status }, { by, agent, now });
  }
  if (prevClaim) {
    t.updated = now;
    logActivity(data, 'released', t, `(${prevClaim})`, { by, agent, now });
  }
  return t;
}

export function claimNextReadyTask(data, filters = {}, opts = {}) {
  const ready = queryTasks(data, { ...filters, ready: true }, { now: opts.now, actor: opts.by ?? data.me });
  if (!ready.length) return null;
  return claimTask(data, ready[0], opts);
}

export function deleteTasks(data, idsOrRefs) {
  const ids = idsOrRefs.map(r => resolveTask(data, r)?.id || String(r));
  const set = new Set(ids);
  const removed = data.tasks.filter(t => set.has(t.id));
  data.tasks = data.tasks.filter(t => !set.has(t.id));
  data.tasks.forEach(t => {
    t.deps = (t.deps || []).filter(d => !set.has(d));
    if (t.parent && set.has(t.parent)) t.parent = null;
  });
  data.comments = data.comments.filter(c => !set.has(c.task));
  if (data.files) {
    data.files = data.files.filter(f => !f.task || !set.has(f.task));
  }
  if (data.notifs) {
    data.notifs = data.notifs.filter(n => !n.task || !set.has(n.task));
  }
  return removed;
}

/* ---------- subtasks ---------- */
export function addSubtask(data, taskOrRef, fields, opts = {}) {
  const now = opts.now ?? Date.now();
  const by = opts.by ?? data.me;
  const agent = normalizeAgentName(opts.agent);
  const t = requireTask(data, taskOrRef);
  const sub = normalizeSubtaskInput(data, typeof fields === 'string' ? { title: fields } : fields);
  t.subtasks.push(sub);
  logActivity(data, 'added subtask to', t, `“${sub.title}”`, { by, agent, now });
  return sub;
}

export function updateSubtask(data, taskOrRef, subRef, patch = {}, opts = {}) {
  const now = opts.now ?? Date.now();
  const by = opts.by ?? data.me;
  const agent = normalizeAgentName(opts.agent);
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
    logActivity(data, s.done ? 'completed subtask on' : 'reopened subtask on', t, `“${s.title}”`, { by, agent, now });
  }
  if (patch.assignee !== undefined) {
    const nv = resolveMember(data, patch.assignee);
    if (nv !== (s.assignee || null)) {
      s.assignee = nv;
      logActivity(data, 'assigned a subtask on', t, nv ? `to ${findMember(data, nv)?.name}` : '(unassigned)', { by, agent, now });
    }
  }
  if (patch.due !== undefined) {
    const nv = validateOptionalDate(patch.due, 'due');
    if (nv !== (s.due || null)) {
      s.due = nv;
      logActivity(data, 'set a subtask due date on', t, nv ? fmt(nv) : '(cleared)', { by, agent, now });
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
  const agent = normalizeAgentName(opts.agent);
  const t = requireTask(data, taskOrRef);
  const s = requireSubtask(t, subRef);
  const promoted = createTask(
    data,
    {
      title: s.title,
      project: t.project,
      parent: t.id,
      status: s.done ? 'done' : 'todo',
      assignee: validMemberId(data, s.assignee || t.assignee),
      priority: t.priority,
      due: s.due || null,
      labels: [...t.labels],
      descMarkdown: s.note || '',
    },
    { by, agent, now },
  );
  t.subtasks = t.subtasks.filter(x => x.id !== s.id);
  logActivity(data, 'converted a subtask of', t, `into ${promoted.key}`, { by, agent, now });
  return promoted;
}

/* ---------- comments ---------- */
export function addComment(data, taskOrRef, text, opts = {}) {
  const now = opts.now ?? Date.now();
  const by = opts.by !== undefined ? resolveMember(data, opts.by) || data.me : data.me;
  const agent = normalizeAgentName(opts.agent);
  const t = requireTask(data, taskOrRef);
  const txt = String(text ?? '').trim();
  if (!txt) throw new DomainError('Comment text cannot be empty');
  const needsOwner = !!opts.needsOwner;
  const c = {
    id: uid('c'),
    task: t.id,
    by,
    ...(agent ? { agent } : {}),
    ...(needsOwner ? { needsOwner: true } : {}),
    at: now,
    text: txt,
    re: {},
  };
  data.comments.push(c);
  logActivity(data, 'commented on', t, '', { by, agent, now });
  const isExternal = Boolean(agent) || by !== data.me;
  if (needsOwner) {
    pushNotif(data, { type: 'blocker', by, agent, task: t, text: 'needs your input on', snippet: txt }, { now });
  } else if (isExternal && mentionsWorkspaceOwner(data, txt)) {
    if (data.notifPrefs?.push_mention !== false) {
      pushNotif(data, { type: 'mention', by, agent, task: t, text: 'mentioned you in', snippet: txt }, { now });
    }
  } else if (isExternal && data.notifPrefs?.push_comment !== false && (Boolean(agent) || t.assignee === data.me)) {
    pushNotif(data, { type: 'comment', by, agent, task: t, text: 'commented on', snippet: txt }, { now });
  }
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
  const parentTask = t.parent ? findTask(data, t.parent) : null;
  const children = childrenOfTask(data, t.id);
  const activeChildren = children.filter(c => c.status !== 'canceled');
  const openDeps = openDepsOfTask(data, t);
  return {
    ...t,
    parent: t.parent || null,
    parentKey: parentTask?.key || null,
    parentTitle: parentTask?.title || null,
    childKeys: children.map(c => c.key),
    childCount: activeChildren.length,
    childDoneCount: activeChildren.filter(c => c.status === 'done').length,
    claimedBy: t.claimedBy || null,
    claimedAt: t.claimedAt || null,
    blocked: openDeps.length > 0,
    ready: isTaskReady(data, t),
    openDepKeys: openDeps.map(d => d.key),
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
  const canceledCount = ts.filter(t => t.status === 'canceled').length;
  return {
    ...p,
    leadName: findMember(data, p.lead)?.name || null,
    taskCount: ts.length,
    openCount: ts.filter(t => !isClosedStatus(t.status)).length,
    doneCount,
    canceledCount,
    docCount: (data.docs || []).filter(d => d.project === p.id).length,
    overdueCount: ts.filter(t => isTaskOverdue(t, now)).length,
    progress: projectProgress(data, p.id),
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
      .map(s => {
        const v = s.trim().toLowerCase();
        return v === 'cancelled' ? 'canceled' : v;
      })
      .filter(Boolean);
    out = out.filter(t => vals.some(v => (v === 'open' ? !isClosedStatus(t.status) : t.status === v)));
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
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => resolveLabel(data, s)?.id || s.toLowerCase());
    out = out.filter(t => vals.some(v => (t.labels || []).includes(v)));
  }
  if (filters.parent !== undefined && filters.parent !== '') {
    const raw = String(filters.parent).trim();
    if (['none', 'null', 'root', 'top'].includes(raw.toLowerCase())) {
      out = out.filter(t => !t.parent);
    } else {
      const pid = requireTask(data, raw).id;
      out = out.filter(t => t.parent === pid);
    }
  }
  const readyFlag = filters.ready === true || (typeof filters.ready === 'string' && ['1', 'true', 'yes'].includes(filters.ready.trim().toLowerCase()));
  if (readyFlag) {
    out = out.filter(t => isTaskReady(data, t));
  }
  if (filters.claimed !== undefined && filters.claimed !== '') {
    const raw = String(filters.claimed).trim();
    const lower = raw.toLowerCase();
    if (['none', 'null', 'false', '0', 'unclaimed'].includes(lower)) {
      out = out.filter(t => !t.claimedBy);
    } else if (['true', '1', 'any', 'claimed'].includes(lower)) {
      out = out.filter(t => !!t.claimedBy);
    } else {
      out = out.filter(t => (t.claimedBy || '').toLowerCase().includes(lower));
    }
  }
  if (filters.due) {
    const v = String(filters.due).trim().toLowerCase();
    out = out.filter(t => {
      if (v === 'nodate' || v === 'none') return !t.due;
      if (!t.due) return false;
      const n = diffD(parse(t.due), today);
      if (v === 'overdue') return isTaskOverdue(t, now);
      if (v === 'today') return !isClosedStatus(t.status) && n === 0;
      if (v === 'week') return !isClosedStatus(t.status) && n >= 0 && n <= 7;
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

  const sortField = filters.sort || (readyFlag ? 'ready' : 'manual');
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
    if (sortField === 'ready') {
      const pw = (PR[b.priority || 'none']?.w ?? 0) - (PR[a.priority || 'none']?.w ?? 0);
      if (pw !== 0) return pw * dir;
      const da = a.due || '9999-99-99';
      const db = b.due || '9999-99-99';
      if (da !== db) return (da > db ? 1 : -1) * dir;
      const oa = a.order ?? 0;
      const ob = b.order ?? 0;
      return (oa > ob ? 1 : oa < ob ? -1 : 0) * dir;
    }
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
  if (!q) return { tasks: [], projects: [], people: [], files: [], docs: [], comments: [] };
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
    docs: (data.docs || []).filter(doc => (has(doc.title) || has(doc.slug) || has(doc.body)) && canSeeProject(data, findProject(data, doc.project), actor)),
    comments: (data.comments || []).filter(c => {
      if (!has(c.text)) return false;
      const t = findTask(data, c.task);
      return !!t && canSeeProject(data, findProject(data, t.project), actor);
    }),
  };
}

/* ---------- atomic field-level workspace diff & merge ---------- */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const KEYED_DATA_LISTS = ['teams', 'labels', 'workspaces', 'files', 'docs', 'notifs', 'events', 'savedViews'];
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
    const baseList = key === 'labels' ? (bd.labels ?? LABELS) : key === 'teams' ? (bd.teams ?? TEAMS_SEED) : bd[key];
    const nextList = key === 'labels' ? (nd.labels ?? LABELS) : key === 'teams' ? (nd.teams ?? TEAMS_SEED) : nd[key];
    const listDiff = diffKeyedList(baseList, nextList);
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
    for (const key of ['files', 'savedViews', 'docs']) {
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
    if (Array.isArray(d.notifs)) {
      for (const n of d.notifs) {
        if (n?.task && deletedProjIds.has(n.project)) {
          const parentTask = findTask(d, n.task);
          if (parentTask && !deletedProjIds.has(parentTask.project)) {
            n.project = parentTask.project;
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
          const patchedStatus = tDiff.fields.set?.status;
          if ((patchedStatus === 'todo' || patchedStatus === 'backlog') && tDiff.fields.set?.claimedBy === undefined && (t.claimedBy || t.claimedAt)) {
            t.claimedBy = null;
            t.claimedAt = null;
            rekeyed = true;
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
      const rawParent = t.parent || null;
      const nextParent = activeProjectParent(d, t.project, rawParent, t.id);
      if (rawParent !== nextParent) rekeyed = true;
      t.parent = nextParent;
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
    if (key === 'labels') ensureLabels(d);
    if (key === 'teams') ensureTeams(d);
    d[key] = applyGenericKeyedList(d[key], patch[key], {
      filterCreated: raw => (!raw.project || !!findProject(d, raw.project)) && (!raw.task || !!findTask(d, raw.task)),
      onAdjust: () => {
        rekeyed = true;
      },
    });
  }
  if (Array.isArray(d.labels)) {
    const validLabelIds = new Set(d.labels.map(l => l.id));
    for (const t of d.tasks) {
      if (Array.isArray(t.labels)) {
        const clean = t.labels.filter(id => validLabelIds.has(id));
        if (clean.length !== t.labels.length) {
          t.labels = clean;
          rekeyed = true;
        }
      }
    }
    for (const sv of d.savedViews || []) {
      if (Array.isArray(sv?.filters)) {
        const res = scrubLabelFiltersInList(sv.filters, validLabelIds);
        if (res.changed) {
          sv.filters = res.filters;
          rekeyed = true;
        }
      }
    }
  }
  for (const t of d.tasks) {
    if ((t.archived || isClosedStatus(t.status) || findProject(d, t.project)?.archived) && (t.claimedBy || t.claimedAt)) {
      t.claimedBy = null;
      t.claimedAt = null;
      rekeyed = true;
    }
  }
  if (Array.isArray(d.files)) {
    const keptFiles = [];
    for (const f of d.files) {
      if (!f || (f.project && !findProject(d, f.project)) || (f.task && !findTask(d, f.task))) {
        rekeyed = true;
        continue;
      }
      if (typeof f.url === 'string' && f.url.startsWith('blob:')) {
        delete f.url;
        rekeyed = true;
      }
      if (f.task) {
        const pt = findTask(d, f.task);
        if (pt && f.project !== pt.project) {
          f.project = pt.project;
          rekeyed = true;
        }
      }
      if (f.by && !findMember(d, f.by)) {
        f.by = d.me;
        rekeyed = true;
      }
      keptFiles.push(f);
    }
    if (keptFiles.length !== d.files.length) d.files = keptFiles;
  }
  if (Array.isArray(d.docs)) {
    const keptDocs = [];
    const seenSlugsByProject = new Map();
    for (const doc of d.docs) {
      if (!doc || !findProject(d, doc.project)) {
        rekeyed = true;
        continue;
      }
      let projSlugs = seenSlugsByProject.get(doc.project);
      if (!projSlugs) {
        projSlugs = new Set();
        seenSlugsByProject.set(doc.project, projSlugs);
      }
      const cleanBase = slugifyDocSlug(doc.slug || doc.title);
      const safeBase = UNSAFE_OBJECT_IDS.has(cleanBase) ? `doc-${cleanBase}` : cleanBase;
      let nextSlug = safeBase;
      let suffix = 2;
      while (projSlugs.has(nextSlug)) {
        nextSlug = `${safeBase}-${suffix++}`;
      }
      if (nextSlug !== doc.slug) {
        doc.slug = nextSlug;
        rekeyed = true;
      }
      projSlugs.add(doc.slug);
      if (doc.by && !findMember(d, doc.by)) {
        doc.by = d.me;
        rekeyed = true;
      }
      if (doc.updatedBy && !findMember(d, doc.updatedBy)) {
        doc.updatedBy = d.me;
        rekeyed = true;
      }
      keptDocs.push(doc);
    }
    if (keptDocs.length !== d.docs.length) d.docs = keptDocs;
  }
  if (Array.isArray(d.notifs)) {
    const kept = [];
    for (const n of d.notifs) {
      if (!n || (n.task && !findTask(d, n.task)) || (n.project && !findProject(d, n.project))) {
        rekeyed = true;
        continue;
      }
      if (n.task) {
        const pt = findTask(d, n.task);
        if (pt && n.project !== pt.project) {
          n.project = pt.project;
          rekeyed = true;
        }
      }
      if (n.by && !findMember(d, n.by)) {
        n.by = null;
        rekeyed = true;
      }
      kept.push(n);
    }
    if (kept.length !== d.notifs.length) d.notifs = kept;
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
  if (Array.isArray(d.labels) && scrubViewsLabelFilters(targetState.views, new Set(d.labels.map(l => l.id)))) {
    rekeyed = true;
  }
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
    if (mergedLink.createdAt) return Boolean(other.mergedAt && other.mergedAt >= mergedLink.createdAt);
    if (mergedLink.observedOpenAt && other.mergedAt) return other.mergedAt >= mergedLink.observedOpenAt;
    if (other.mergedSeq && mergedLink.linkedSeq) return other.mergedSeq > mergedLink.linkedSeq;
    const otherKey = `${other.repo.toLowerCase()}#${other.number}`;
    return !preExistingMergedKeys.has(otherKey);
  });
}

function isNewerPartialThan(partial, link) {
  if (partial.repo.toLowerCase() === link.repo.toLowerCase()) return partial.number > link.number;
  if (partial.createdAt) return !link.mergedAt || link.mergedAt < partial.createdAt;
  if (partial.observedOpenAt && link.mergedAt) return link.mergedAt < partial.observedOpenAt;
  if (partial.linkedSeq && link.mergedSeq) return partial.linkedSeq > link.mergedSeq;
  return true;
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
  const hasSatisfiedPostCancelMerge = taskObj => {
    if (taskObj.status !== 'canceled' || (taskObj.prs || []).some(x => x.state === 'open')) return false;
    const preMerged = preExistingMergedByTask.get(taskObj.id) || new Set();
    const nowUnsatisfied = unsatisfiedMergedPartials(taskObj.prs, preMerged);
    return taskObj.prs.some(
      m =>
        m.state === 'merged' &&
        m.closing &&
        m.mergedAtExact &&
        (!taskObj.canceledAt || (m.mergedAt && m.mergedAt > taskObj.canceledAt)) &&
        !isIncompleteStackMerge(taskObj.prs, m, preMerged) &&
        !nowUnsatisfied.some(p => isNewerPartialThan(p, m)),
    );
  };

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
        if (prev.state === 'open' && hasSatisfiedPostCancelMerge(t)) {
          applyTaskPatch(data, t, { status: 'done' }, { by, agent: opts.agent, now, source: 'github' });
        }
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
        observedOpenAt: prev?.observedOpenAt || (incoming.state === 'open' ? incoming.createdAt || now : undefined),
        linkedSeq,
        mergedSeq,
        mergedAt:
          incoming.state === 'merged'
            ? incoming.mergedAt
              ? incoming.mergedAt
              : prev?.state === 'merged'
                ? prev.mergedAt || undefined
                : incoming.updatedAt || (prev?.state === 'open' ? now : undefined)
            : undefined,
        mergedAtExact: incoming.state === 'merged' && Boolean(incoming.mergedAt || prev?.mergedAtExact),
      });
      if (!nextLink) continue;
      if (deepEqual(prev, nextLink)) {
        if (hasSatisfiedPostCancelMerge(t)) {
          applyTaskPatch(data, t, { status: 'done' }, { by, agent: opts.agent, now, source: 'github' });
          touchedIds.add(t.id);
          changed = true;
        }
        continue;
      }

      const preMerged = preExistingMergedByTask.get(t.id) || new Set();
      const gainedMergedAt = nextLink.state === 'merged' && prev?.state === 'merged' && !prev.mergedAt && !!nextLink.mergedAt;
      const prevUnsatisfied = gainedMergedAt ? unsatisfiedMergedPartials(t.prs, preMerged) : [];

      const idx = t.prs.findIndex(samePr);
      if (idx >= 0) t.prs[idx] = nextLink;
      else t.prs.push(nextLink);

      const prLabel = `${nextLink.repo}#${nextLink.number}`;
      const prSnippet = nextLink.title ? `${prLabel}: ${nextLink.title}` : prLabel;
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
      const allowMergeComplete =
        t.status !== 'done' && (t.status !== 'canceled' || Boolean(incoming.mergedAt && (!t.canceledAt || incoming.mergedAt > t.canceledAt)));

      if (becameOpenDraft) {
        if (t.status === 'backlog' || t.status === 'todo') {
          applyTaskPatch(data, t, { status: 'progress' }, { by, agent: opts.agent, now, source: 'github', snippet: prSnippet });
        }
      } else if (becameOpenReady) {
        if (nextLink.closing) {
          const closedAt = t.status === 'done' ? t.completedAt : t.status === 'canceled' ? t.canceledAt : 0;
          const reopenCompleted =
            isClosedStatus(t.status) && (prev?.state === 'closed' || Boolean(nextLink.createdAt && closedAt && nextLink.createdAt > closedAt));
          if (['backlog', 'todo', 'progress'].includes(t.status) || reopenCompleted) {
            applyTaskPatch(data, t, { status: 'review' }, { by, agent: opts.agent, now, source: 'github', snippet: prSnippet });
          }
        } else if (t.status === 'backlog' || t.status === 'todo') {
          applyTaskPatch(data, t, { status: 'progress' }, { by, agent: opts.agent, now, source: 'github', snippet: prSnippet });
        }
      } else if (becameMerged && nextLink.closing) {
        const hasOpenPr = t.prs.some(x => x.state === 'open');
        if (!hasOpenPr) {
          const nowUnsatisfied = unsatisfiedMergedPartials(t.prs, preMerged);
          const waitingOnStack = isIncompleteStackMerge(t.prs, nextLink, preMerged) || nowUnsatisfied.some(p => isNewerPartialThan(p, nextLink));
          if (waitingOnStack) {
            if (t.status === 'backlog' || t.status === 'todo') {
              applyTaskPatch(data, t, { status: 'progress' }, { by, agent: opts.agent, now, source: 'github', snippet: prSnippet });
            }
          } else if (allowMergeComplete) {
            applyTaskPatch(data, t, { status: 'done' }, { by, agent: opts.agent, now, source: 'github', snippet: prSnippet });
          }
        }
      } else if (gainedMergedAt && nextLink.closing && prevUnsatisfied.length > 0) {
        const hasOpenPr = t.prs.some(x => x.state === 'open');
        if (!hasOpenPr) {
          const nowUnsatisfied = unsatisfiedMergedPartials(t.prs, preMerged);
          const nowKeys = new Set(nowUnsatisfied.map(p => `${p.repo.toLowerCase()}#${p.number}`));
          const newlySatisfied = prevUnsatisfied.some(p => !nowKeys.has(`${p.repo.toLowerCase()}#${p.number}`));
          if (newlySatisfied && !nowUnsatisfied.some(p => isNewerPartialThan(p, nextLink)) && allowMergeComplete) {
            applyTaskPatch(data, t, { status: 'done' }, { by, agent: opts.agent, now, source: 'github', snippet: prSnippet });
          }
        }
      } else if (becameClosedUnmerged) {
        const hasReadyOpen = t.prs.some(x => x.state === 'open' && !x.draft);
        const hasMergedClosing = t.prs.some(x => x.state === 'merged' && x.closing);
        if (t.status === 'review' && !hasReadyOpen && !hasMergedClosing) {
          applyTaskPatch(data, t, { status: 'progress' }, { by, agent: opts.agent, now, source: 'github', snippet: prSnippet });
        }
      }
      if (hasSatisfiedPostCancelMerge(t)) {
        applyTaskPatch(data, t, { status: 'done' }, { by, agent: opts.agent, now, source: 'github', snippet: prSnippet });
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
