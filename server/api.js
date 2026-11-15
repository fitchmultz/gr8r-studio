/* Domain REST API for Gr8r Studio: atomic project, task, subtask, comment,
   activity, and search operations backed by src/core/domain.js. */
import { PRIOS, PSTAT, STATUSES } from '../src/core/constants.js';
import {
  DomainError,
  addComment,
  addSubtask,
  applyTaskPatch,
  applyWorkspacePatch,
  childrenOfTask,
  commentsOfTask,
  createDefaultState,
  createLabel,
  createProject,
  createTask,
  deleteComment,
  deleteLabel,
  deleteProject,
  deleteTasks,
  ensureLabels,
  ensureTeams,
  findMember,
  findProject,
  findTask,
  formatProjectForApi,
  formatTaskForApi,
  isWorkspacePatchEmpty,
  promoteSubtask,
  queryTasks,
  removeSubtask,
  requireProject,
  requireTask,
  resolveMember,
  resolveProject,
  resolveTask,
  searchWorkspace,
  syncGitHubPullRequests,
  updateLabel,
  updateProject,
  updateSubtask,
} from '../src/core/domain.js';

function enrichComment(data, c) {
  return {
    ...c,
    byName: findMember(data, c.by)?.name || null,
    taskKey: findTask(data, c.task)?.key || null,
  };
}

function enrichActivity(data, a) {
  const t = a.task ? findTask(data, a.task) : null;
  const p = a.project ? findProject(data, a.project) : t ? findProject(data, t.project) : null;
  return {
    ...a,
    byName: findMember(data, a.by)?.name || null,
    taskKey: t?.key || null,
    taskTitle: t?.title || null,
    projectKey: p?.key || null,
    projectName: p?.name || null,
  };
}

function resolveActor(data, rawBy) {
  if (rawBy === undefined || rawBy === null || rawBy === '') return data.me;
  return resolveMember(data, rawBy) || data.me;
}

function mapApiTaskInput(body) {
  if (!body || typeof body !== 'object') return body;
  if (body.desc !== undefined && body.descMarkdown === undefined && body.descHtml === undefined) {
    const { desc, ...rest } = body;
    return { ...rest, descMarkdown: desc };
  }
  return body;
}

function parseJsonBody(raw) {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new DomainError('Request body must be a JSON object', 400);
    }
    return parsed;
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw new DomainError('invalid body', 400);
  }
}

export async function handleDomainApi({ req, res, url, getStore, commitState, readBody, send }) {
  let segments;
  try {
    segments = url.pathname
      .slice('/api/'.length)
      .split('/')
      .filter(Boolean)
      .map(s => decodeURIComponent(s));
  } catch {
    return send(res, 400, { error: 'bad request' });
  }
  const method = req.method;

  const readView = () => {
    const cur = getStore();
    return { rev: cur.rev, initialized: !!cur.state, state: cur.state || createDefaultState() };
  };

  const mutate = async fn => {
    const body = parseJsonBody(await readBody(req));
    const cur = getStore();
    if (body.ifRev !== undefined) {
      if (!Number.isInteger(body.ifRev)) throw new DomainError('ifRev must be an integer', 400);
      if (body.ifRev !== cur.rev) {
        send(res, 409, { error: 'conflict', rev: cur.rev });
        return null;
      }
    }
    const draft = cur.state ? structuredClone(cur.state) : createDefaultState();
    const out = fn(draft.data, body, draft);
    const committed = commitState(draft);
    return { rev: committed.rev, ...out };
  };

  try {
    // GET /api/workspace
    if (segments.length === 1 && segments[0] === 'workspace' && method === 'GET') {
      const { rev, initialized, state } = readView();
      const d = state.data;
      const orderedIds = new Set(d.projOrder || []);
      const orderedProjects = [...(d.projOrder || []).map(id => findProject(d, id)).filter(Boolean), ...d.projects.filter(p => !orderedIds.has(p.id))];
      return send(res, 200, {
        rev,
        initialized,
        ws: d.ws,
        me: d.me,
        members: d.members,
        teams: ensureTeams(d),
        projects: orderedProjects.filter(p => !p.archived).map(p => formatProjectForApi(d, p)),
        vocab: {
          statuses: STATUSES,
          priorities: PRIOS,
          labels: ensureLabels(d).map(l => ({ id: l.id, name: l.name, color: l.c })),
          projectStatuses: Object.entries(PSTAT).map(([id, v]) => ({ id, name: v.name })),
        },
      });
    }

    // /api/labels
    if (segments[0] === 'labels') {
      if (segments.length === 1 && method === 'GET') {
        const { rev, state } = readView();
        return send(res, 200, { rev, labels: ensureLabels(state.data) });
      }
      if (segments.length === 1 && method === 'POST') {
        const result = await mutate((data, body) => {
          const label = createLabel(data, body);
          return { label, labels: ensureLabels(data) };
        });
        if (result) send(res, 201, result);
        return;
      }
      if (segments.length === 2) {
        const ref = segments[1];
        if (method === 'PATCH') {
          const result = await mutate((data, body) => {
            const label = updateLabel(data, ref, body);
            return { label, labels: ensureLabels(data) };
          });
          if (result) send(res, 200, result);
          return;
        }
        if (method === 'DELETE') {
          const result = await mutate((data, _body, draft) => {
            const label = deleteLabel(data, ref, { views: draft.views });
            return { deleted: label.id, labels: ensureLabels(data) };
          });
          if (result) send(res, 200, result);
          return;
        }
      }
    }

    // PATCH /api/workspace — atomic field-level merge for browser UI & offline edits
    if (segments.length === 1 && segments[0] === 'workspace' && method === 'PATCH') {
      const body = parseJsonBody(await readBody(req));
      if (!body.patch || typeof body.patch !== 'object' || Array.isArray(body.patch)) {
        throw new DomainError('patch object is required', 400);
      }
      const cur = getStore();
      if (!cur.state) {
        return send(res, 409, { error: 'uninitialized', rev: cur.rev, state: null });
      }
      if (body.baseRev !== undefined && !Number.isInteger(body.baseRev)) {
        throw new DomainError('baseRev must be an integer', 400);
      }
      const baseRev = Number.isInteger(body.baseRev) ? body.baseRev : cur.rev;
      if (isWorkspacePatchEmpty(body.patch)) {
        const merged = baseRev !== cur.rev;
        return send(res, 200, { rev: cur.rev, merged, ...(merged ? { state: cur.state } : {}) });
      }
      const draft = structuredClone(cur.state);
      const { rekeyed } = applyWorkspacePatch(draft, body.patch);
      const merged = baseRev !== cur.rev || rekeyed;
      const committed = commitState(draft);
      return send(res, 200, { rev: committed.rev, merged, ...(merged ? { state: committed.state } : {}) });
    }

    // POST /api/github/pull-requests — idempotently link PRs to KEY-123 tasks & transition status
    if (segments.length === 2 && segments[0] === 'github' && segments[1] === 'pull-requests' && method === 'POST') {
      const body = parseJsonBody(await readBody(req));
      const rawList = Array.isArray(body.pullRequests) ? body.pullRequests : body.pullRequest ? [body.pullRequest] : [body];
      if (!rawList.length) {
        const cur = getStore();
        return send(res, 200, { rev: cur.rev, changed: false, updated: [] });
      }
      const cur = getStore();
      if (!cur.state) {
        return send(res, 409, { error: 'uninitialized', rev: cur.rev });
      }
      const draft = structuredClone(cur.state);
      const { changed, updatedTasks } = syncGitHubPullRequests(draft.data, rawList, {
        by: resolveActor(draft.data, body.by),
      });
      const rev = changed ? commitState(draft).rev : cur.rev;
      return send(res, 200, {
        rev,
        changed,
        updated: updatedTasks.map(t => formatTaskForApi(draft.data, t)),
      });
    }

    // GET /api/search?q=...
    if (segments.length === 1 && segments[0] === 'search' && method === 'GET') {
      const { rev, state } = readView();
      const q = url.searchParams.get('q') || '';
      const r = searchWorkspace(state.data, q);
      return send(res, 200, {
        rev,
        query: q,
        tasks: r.tasks.map(t => formatTaskForApi(state.data, t)),
        projects: r.projects.map(p => formatProjectForApi(state.data, p)),
        people: r.people,
        files: r.files,
        comments: r.comments.map(c => enrichComment(state.data, c)),
      });
    }

    // GET /api/activity
    if (segments.length === 1 && segments[0] === 'activity' && method === 'GET') {
      const { rev, state } = readView();
      const d = state.data;
      const projFilter = url.searchParams.get('project');
      const taskFilter = url.searchParams.get('task');
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      const pid = projFilter ? requireProject(d, projFilter).id : null;
      const tid = taskFilter ? requireTask(d, taskFilter).id : null;
      const items = d.activity
        .filter(a => (!pid || a.project === pid) && (!tid || a.task === tid))
        .slice(0, limit)
        .map(a => enrichActivity(d, a));
      return send(res, 200, { rev, activity: items });
    }

    // /api/projects
    if (segments[0] === 'projects') {
      if (segments.length === 1 && method === 'GET') {
        const { rev, state } = readView();
        const d = state.data;
        const incArch = ['1', 'true', 'all'].includes((url.searchParams.get('archived') || '').toLowerCase());
        const orderedIds = new Set(d.projOrder || []);
        const all = [...(d.projOrder || []).map(id => findProject(d, id)).filter(Boolean), ...d.projects.filter(p => !orderedIds.has(p.id))];
        const list = (incArch ? all : all.filter(p => !p.archived)).map(p => formatProjectForApi(d, p));
        return send(res, 200, { rev, projects: list });
      }
      if (segments.length === 1 && method === 'POST') {
        const result = await mutate((data, body) => {
          const p = createProject(data, body, { by: resolveActor(data, body.by) });
          return { project: formatProjectForApi(data, p) };
        });
        if (result) send(res, 201, result);
        return;
      }
      if (segments.length === 2) {
        const ref = segments[1];
        if (method === 'GET') {
          const { rev, state } = readView();
          const d = state.data;
          const p = requireProject(d, ref);
          const tasks = queryTasks(d, { project: p.id, archived: url.searchParams.get('archived') }).map(t => formatTaskForApi(d, t));
          return send(res, 200, { rev, project: formatProjectForApi(d, p), tasks });
        }
        if (method === 'PATCH') {
          const result = await mutate((data, body) => {
            const p = updateProject(data, ref, body, { by: resolveActor(data, body.by) });
            return { project: formatProjectForApi(data, p) };
          });
          if (result) send(res, 200, result);
          return;
        }
        if (method === 'DELETE') {
          const result = await mutate(data => {
            const p = deleteProject(data, ref);
            return { deleted: p.id, key: p.key };
          });
          if (result) send(res, 200, result);
          return;
        }
      }
    }

    // /api/tasks
    if (segments[0] === 'tasks') {
      if (segments.length === 1 && method === 'GET') {
        const { rev, state } = readView();
        const d = state.data;
        const filters = Object.fromEntries(url.searchParams.entries());
        const tasks = queryTasks(d, filters).map(t => formatTaskForApi(d, t));
        return send(res, 200, { rev, tasks });
      }
      if (segments.length === 1 && method === 'POST') {
        const result = await mutate((data, body) => {
          const by = resolveActor(data, body.by);
          if (Array.isArray(body.tasks)) {
            if (!body.tasks.length) throw new DomainError('tasks array cannot be empty');
            const created = body.tasks.map(item => createTask(data, mapApiTaskInput({ ...(body.project ? { project: body.project } : {}), ...item }), { by }));
            return { tasks: created.map(t => formatTaskForApi(data, t)) };
          }
          const t = createTask(data, mapApiTaskInput(body), { by });
          return { task: formatTaskForApi(data, t) };
        });
        if (result) send(res, 201, result);
        return;
      }
      if (segments.length === 2) {
        const ref = segments[1];
        if (method === 'GET') {
          const { rev, state } = readView();
          const d = state.data;
          const t = requireTask(d, ref);
          const subIssues = childrenOfTask(d, t.id).map(c => formatTaskForApi(d, c));
          const comments = commentsOfTask(d, t.id).map(c => enrichComment(d, c));
          const activity = d.activity
            .filter(a => a.task === t.id)
            .slice(0, 50)
            .map(a => enrichActivity(d, a));
          return send(res, 200, { rev, task: formatTaskForApi(d, t), subIssues, comments, activity });
        }
        if (method === 'PATCH') {
          const result = await mutate((data, body) => {
            const out = applyTaskPatch(data, ref, mapApiTaskInput(body), { by: resolveActor(data, body.by) });
            return {
              task: formatTaskForApi(data, out.task),
              spawned: out.spawned ? formatTaskForApi(data, out.spawned) : null,
            };
          });
          if (result) send(res, 200, result);
          return;
        }
        if (method === 'DELETE') {
          const result = await mutate(data => {
            const t = requireTask(data, ref);
            deleteTasks(data, [t.id]);
            return { deleted: t.id, key: t.key };
          });
          if (result) send(res, 200, result);
          return;
        }
      }

      // /api/tasks/:ref/subtasks[/:subId[/promote]]
      if (segments.length >= 3 && segments[2] === 'subtasks') {
        const taskRef = segments[1];
        if (segments.length === 3 && method === 'POST') {
          const result = await mutate((data, body) => {
            const sub = addSubtask(data, taskRef, body, { by: resolveActor(data, body.by) });
            const t = requireTask(data, taskRef);
            return { subtask: sub, task: formatTaskForApi(data, t) };
          });
          if (result) send(res, 201, result);
          return;
        }
        if (segments.length === 4) {
          const subRef = segments[3];
          if (method === 'PATCH') {
            const result = await mutate((data, body) => {
              const sub = updateSubtask(data, taskRef, subRef, body, { by: resolveActor(data, body.by) });
              const t = requireTask(data, taskRef);
              return { subtask: sub, task: formatTaskForApi(data, t) };
            });
            if (result) send(res, 200, result);
            return;
          }
          if (method === 'DELETE') {
            const result = await mutate(data => {
              const sub = removeSubtask(data, taskRef, subRef);
              const t = requireTask(data, taskRef);
              return { deleted: sub.id, task: formatTaskForApi(data, t) };
            });
            if (result) send(res, 200, result);
            return;
          }
        }
        if (segments.length === 5 && segments[4] === 'promote' && method === 'POST') {
          const subRef = segments[3];
          const result = await mutate((data, body) => {
            const promoted = promoteSubtask(data, taskRef, subRef, { by: resolveActor(data, body.by) });
            const parent = requireTask(data, taskRef);
            return {
              task: formatTaskForApi(data, promoted),
              parentTask: formatTaskForApi(data, parent),
            };
          });
          if (result) send(res, 201, result);
          return;
        }
      }

      // /api/tasks/:ref/comments[/:commentId]
      if (segments.length >= 3 && segments[2] === 'comments') {
        const taskRef = segments[1];
        if (segments.length === 3 && method === 'GET') {
          const { rev, state } = readView();
          const d = state.data;
          const t = requireTask(d, taskRef);
          return send(res, 200, { rev, comments: commentsOfTask(d, t.id).map(c => enrichComment(d, c)) });
        }
        if (segments.length === 3 && method === 'POST') {
          const result = await mutate((data, body) => {
            const c = addComment(data, taskRef, body.text, { by: resolveActor(data, body.by) });
            const t = requireTask(data, taskRef);
            return { comment: enrichComment(data, c), task: formatTaskForApi(data, t) };
          });
          if (result) send(res, 201, result);
          return;
        }
        if (segments.length === 4 && method === 'DELETE') {
          const commentId = segments[3];
          const result = await mutate(data => {
            const t = requireTask(data, taskRef);
            const existing = commentsOfTask(data, t.id).find(c => c.id === commentId);
            if (!existing) throw new DomainError(`Comment not found on ${t.key}: ${commentId}`, 404);
            deleteComment(data, commentId);
            return { deleted: commentId };
          });
          if (result) send(res, 200, result);
          return;
        }
      }
    }

    // Convenience lookup: GET /api/resolve/:ref resolves either project key/id or task key/id
    if (segments.length === 2 && segments[0] === 'resolve' && method === 'GET') {
      const { rev, state } = readView();
      const d = state.data;
      const ref = segments[1];
      const t = resolveTask(d, ref);
      if (t) return send(res, 200, { rev, kind: 'task', task: formatTaskForApi(d, t) });
      const p = resolveProject(d, ref);
      if (p) return send(res, 200, { rev, kind: 'project', project: formatProjectForApi(d, p) });
      return send(res, 404, { error: `Not found: ${ref}` });
    }

    return send(res, 404, { error: 'not found' });
  } catch (err) {
    if (err instanceof DomainError) {
      return send(res, err.status || 400, { error: err.message });
    }
    throw err;
  }
}
