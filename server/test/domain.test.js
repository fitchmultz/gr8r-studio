import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToMarkdown, markdownToHtml, stripHtml } from '../../src/core/markdown.js';
import {
  DomainError,
  addComment,
  addSubtask,
  applyTaskPatch,
  applyWorkspacePatch,
  childrenOfTask,
  claimNextReadyTask,
  claimTask,
  createDefaultState,
  createLabel,
  createProject,
  createTask,
  deleteLabel,
  deleteProject,
  deleteTasks,
  diffWorkspacePatch,
  duplicateProject,
  duplicateTask,
  ensureLabels,
  formatProjectForApi,
  formatTaskForApi,
  isTaskBlocked,
  isTaskOverdue,
  isTaskReady,
  projectProgress,
  promoteSubtask,
  queryTasks,
  releaseTask,
  removeMember,
  removeSubtask,
  resolveLabel,
  searchWorkspace,
  syncGitHubPullRequests,
  updateLabel,
  updateProject,
  updateSubtask,
} from '../../src/core/domain.js';

const FIXED_NOW = Date.UTC(2026, 10, 14, 18, 0, 0);

test('shared domain and markdown modules run in Node without browser globals', () => {
  assert.equal(typeof globalThis.document, 'undefined');
  const st = createDefaultState(FIXED_NOW);
  assert.equal(st.data.projects[0].key, 'GS');
  assert.equal(st.data.tasks.length, 5);
});

test('markdown <-> drawer HTML round-trips losslessly and escapes raw HTML', () => {
  const pidHtml =
    '<h4>Goal</h4><p>Surface native <b>UsageDoc</b> token and cost accounting inside personal <b>Agent</b> chats—matching <code>/review</code>.</p>' +
    '<h4>Files</h4><ul><li><code>src/chat.ts</code> and <a href="https://example.com/docs">docs</a></li><li><i>Fast</i> path</li></ul>' +
    '<ol><li>First</li><li>Second</li></ol><pre><code>const x = a &lt; b &amp;&amp; c &gt; d;</code></pre>';

  const md = htmlToMarkdown(pidHtml);
  assert.match(md, /^#### Goal/m);
  assert.match(md, /\*\*UsageDoc\*\*/);
  assert.match(md, /`\/review`/);
  assert.match(md, /\[docs\]\(https:\/\/example\.com\/docs\)/);
  assert.match(md, /1\. First\n2\. Second/);
  assert.match(md, /```\nconst x = a < b && c > d;\n```/);
  assert.equal(markdownToHtml(md), pidHtml);

  const escaped = markdownToHtml('Check <script>alert(1)</script> & `<b>literal</b>`');
  assert.equal(escaped, '<p>Check &lt;script&gt;alert(1)&lt;/script&gt; &amp; <code>&lt;b&gt;literal&lt;/b&gt;</code></p>');
  assert.equal(stripHtml(pidHtml).includes('Surface native UsageDoc'), true);
});

test('task creation enforces sequential keys, date clamping, validation, and markdown descriptions', () => {
  const { data } = createDefaultState(FIXED_NOW);
  const p = createProject(data, { name: 'Pi Durable', key: 'PID', status: 'active' }, { now: FIXED_NOW });
  assert.equal(p.key, 'PID');
  assert.equal(data.projOrder[0], p.id);

  const t1 = createTask(
    data,
    {
      project: 'pid',
      title: 'Slice 1',
      priority: 'high',
      assignee: 'me',
      start: '2026-11-20',
      due: '2026-11-16',
      labels: ['Backend', 'frontend'],
      descMarkdown: '#### Summary\n\nShip **UsageDoc** in `chat.ts`.',
      subtasks: ['Step A', { title: 'Step B', note: 'Verify live' }],
    },
    { now: FIXED_NOW },
  );
  assert.equal(t1.key, 'PID-201');
  assert.equal(t1.assignee, 'm1');
  assert.equal(t1.start, '2026-11-16');
  assert.deepEqual(t1.labels, ['backend', 'frontend']);
  assert.equal(t1.desc, '<h4>Summary</h4><p>Ship <b>UsageDoc</b> in <code>chat.ts</code>.</p>');
  assert.equal(t1.subtasks.length, 2);

  // Imported high sequence numbers are never reused.
  createTask(data, { project: 'PID', key: 'PID-250', title: 'Imported' }, { now: FIXED_NOW });
  const afterImport = createTask(data, { project: 'PID', title: 'Next slice' }, { now: FIXED_NOW });
  assert.equal(afterImport.key, 'PID-251');

  assert.throws(() => createTask(data, { project: 'PID', title: 'Bad label', labels: ['nonexistent'] }), DomainError);
  assert.throws(() => createTask(data, { project: 'PID', title: 'Bad status', status: 'doing' }), DomainError);
});

test('applyTaskPatch preserves completion, recurrence, project-move rekeying, and cascade rules', () => {
  const { data } = createDefaultState(FIXED_NOW);
  const pid = createProject(data, { name: 'Pi Durable', key: 'PID', status: 'active' }, { now: FIXED_NOW });
  const dep = createTask(data, { project: pid.id, title: 'Prerequisite' }, { now: FIXED_NOW });
  const rec = createTask(
    data,
    {
      project: pid.id,
      title: 'Weekly audit',
      status: 'progress',
      due: '2026-11-14',
      recur: 'Weekly',
      deps: ['PID-201'],
      subtasks: [{ title: 'Check logs', done: true }],
    },
    { now: FIXED_NOW },
  );
  assert.deepEqual(rec.deps, [dep.id]);

  const res = applyTaskPatch(data, 'PID-202', { status: 'done' }, { now: FIXED_NOW + 1000 });
  assert.equal(res.completed, true);
  assert.equal(rec.prevStatus, 'progress');
  assert.equal(rec.completedAt, FIXED_NOW + 1000);
  assert.ok(res.spawned);
  assert.equal(res.spawned.key, 'PID-203');
  assert.equal(res.spawned.status, 'todo');
  assert.equal(res.spawned.due, '2026-11-21');
  assert.equal(res.spawned.subtasks[0].done, false);

  // Moving to another project assigns a key in the destination project and drops cross-project deps.
  applyTaskPatch(data, res.spawned.id, { project: 'GS', addDeps: [] }, { now: FIXED_NOW + 2000 });
  assert.match(res.spawned.key, /^GS-/);
  assert.deepEqual(res.spawned.deps, []);

  // Deleting a dependency cascades cleanly out of dependent tasks and comments.
  addComment(data, dep.id, 'Shipped baseline', { now: FIXED_NOW + 3000 });
  addComment(data, rec.id, 'Audit complete', { now: FIXED_NOW + 3000 });
  deleteTasks(data, ['PID-201']);
  assert.deepEqual(rec.deps, []);
  assert.equal(data.comments.length, 1);

  deleteProject(data, 'PID');
  assert.equal(
    data.projects.some(p => p.key === 'PID'),
    false,
  );
  assert.equal(data.comments.length, 0);
});

test('duplicating projects/tasks and moving+completing recurring tasks preserve HTML and destination project', () => {
  const { data } = createDefaultState(FIXED_NOW);
  const alpha = createProject(data, { name: 'Alpha Service', key: 'ALP', status: 'active' }, { now: FIXED_NOW });
  const beta = createProject(data, { name: 'Beta Service', key: 'BET', status: 'active' }, { now: FIXED_NOW });

  const t1 = createTask(data, { project: alpha.id, title: 'Base', desc: 'Research &amp; <b>development</b>' }, { now: FIXED_NOW });
  const t2 = createTask(
    data,
    { project: alpha.id, title: 'Dependent', deps: [t1.key], due: '2026-11-14', recur: 'Weekly', desc: 'Hello &amp; world' },
    { now: FIXED_NOW },
  );

  const dupT1 = duplicateTask(data, t1.id, { now: FIXED_NOW + 100 });
  assert.equal(dupT1.desc, 'Research &amp; <b>development</b>');
  assert.equal(dupT1.key, 'ALP-203');

  const alphaCopy = duplicateProject(data, alpha.id, { now: FIXED_NOW + 200 });
  assert.notEqual(alphaCopy.id, alpha.id);
  assert.notEqual(alphaCopy.key, alpha.key);
  const copiedTasks = queryTasks(data, { project: alphaCopy.id });
  assert.equal(copiedTasks.length, 3);
  const copiedBase = copiedTasks.find(t => t.title === 'Base');
  const copiedDep = copiedTasks.find(t => t.title === 'Dependent');
  assert.equal(copiedBase.desc, 'Research &amp; <b>development</b>');
  assert.deepEqual(copiedDep.deps, [copiedBase.id]);

  const moveDone = applyTaskPatch(data, t2.id, { project: beta.id, status: 'done' }, { now: FIXED_NOW + 300 });
  assert.equal(t2.project, beta.id);
  assert.equal(t2.key, 'BET-201');
  assert.ok(moveDone.spawned);
  assert.equal(moveDone.spawned.project, beta.id);
  assert.equal(moveDone.spawned.key, 'BET-202');
  assert.equal(moveDone.spawned.desc, 'Hello &amp; world');
});

test('stale dependencies, removed members, and archived project queries preserve invariants cleanly', () => {
  const { data } = createDefaultState(FIXED_NOW);
  data.members.push({ id: 'm2', name: 'Sam Rivera', email: 'sam@example.com', role: 'Member' });

  const alpha = createProject(data, { name: 'Alpha', key: 'ALP', lead: 'm2', members: ['m2'], status: 'active' }, { now: FIXED_NOW });
  const beta = createProject(data, { name: 'Beta', key: 'BET', status: 'active' }, { now: FIXED_NOW });

  const depArchived = createTask(data, { project: alpha.id, title: 'Dep Archived' }, { now: FIXED_NOW });
  const depMoved = createTask(data, { project: alpha.id, title: 'Dep Moved' }, { now: FIXED_NOW });
  const rec = createTask(
    data,
    {
      project: alpha.id,
      title: 'Weekly Rollup',
      assignee: 'm2',
      deps: [depArchived.id, depMoved.id],
      due: '2026-11-14',
      recur: 'Weekly',
      subtasks: [{ title: 'Check logs', assignee: 'm2' }],
    },
    { now: FIXED_NOW },
  );

  applyTaskPatch(data, depArchived.id, { archived: true }, { now: FIXED_NOW + 100 });
  assert.equal(rec.deps.includes(depArchived.id), false);
  applyTaskPatch(data, depMoved.id, { project: beta.id }, { now: FIXED_NOW + 200 });
  assert.equal(rec.deps.includes(depMoved.id), false);

  // Atomic project milestone mutations preserve concurrent milestones.
  updateProject(data, alpha.id, { addMilestones: [{ name: 'M1', date: '2026-11-20' }] }, { now: FIXED_NOW + 210 });
  updateProject(data, alpha.id, { addMilestones: [{ name: 'M2', date: '2026-11-25' }] }, { now: FIXED_NOW + 220 });
  updateProject(data, alpha.id, { removeMilestones: ['m1'] }, { now: FIXED_NOW + 230 });
  assert.deepEqual(alpha.milestones, [{ name: 'M2', date: '2026-11-25' }]);

  removeMember(data, 'm2');
  assert.equal(alpha.lead, data.me);
  assert.equal(rec.assignee, null);
  assert.equal(rec.subtasks[0].assignee, null);

  alpha.lead = 'm_legacy_removed';
  const alphaDup = duplicateProject(data, alpha.id, { now: FIXED_NOW + 300 });
  assert.equal(alphaDup.lead, data.me);

  const recDup = duplicateTask(data, rec.id, { now: FIXED_NOW + 400 });
  assert.deepEqual(recDup.deps, []);

  const doneRes = applyTaskPatch(data, rec.id, { status: 'done' }, { now: FIXED_NOW + 500 });
  assert.equal(doneRes.completed, true);
  assert.ok(doneRes.spawned);
  assert.deepEqual(doneRes.spawned.deps, []);

  updateProject(data, beta.id, { archived: true }, { now: FIXED_NOW + 600 });
  assert.equal(
    queryTasks(data, {}).some(t => t.project === beta.id),
    false,
  );
  assert.equal(queryTasks(data, { project: beta.id }).length, 1);
  assert.equal(
    queryTasks(data, { archived: 'ALL' }).some(t => t.project === beta.id),
    true,
  );
});

test('subtask lifecycle, promotion, and workspace queries share identical invariants', () => {
  const { data } = createDefaultState(FIXED_NOW);
  createProject(data, { name: 'Pi Durable', key: 'PID', status: 'active' }, { now: FIXED_NOW });
  const parent = createTask(data, { project: 'PID', title: 'Parent slice', priority: 'high', labels: ['backend'], assignee: 'me' }, { now: FIXED_NOW });

  const s1 = addSubtask(data, 'PID-201', { title: 'Wire SSE', note: 'Use `text/event-stream`' }, { now: FIXED_NOW });
  const s2 = addSubtask(data, 'PID-201', 'Add tests', { now: FIXED_NOW });
  updateSubtask(data, 'PID-201', s1.id, { done: true, due: '2026-11-15' }, { now: FIXED_NOW + 500 });
  assert.equal(s1.done, true);
  assert.equal(s1.due, '2026-11-15');

  const promoted = promoteSubtask(data, 'PID-201', s1.id, { now: FIXED_NOW + 1000 });
  assert.equal(promoted.key, 'PID-202');
  assert.equal(promoted.status, 'done');
  assert.equal(promoted.desc, '<p>Use <code>text/event-stream</code></p>');
  assert.equal(parent.subtasks.length, 1);

  removeSubtask(data, 'PID-201', s2.id, { now: FIXED_NOW + 1500 });
  assert.equal(parent.subtasks.length, 0);

  updateProject(data, 'PID', { status: 'risk' }, { now: FIXED_NOW + 2000 });
  assert.equal(data.activity[0].verb, 'changed status of project');

  const openPid = queryTasks(data, { project: 'PID', status: 'open' }, { now: FIXED_NOW });
  assert.deepEqual(
    openPid.map(t => t.key),
    ['PID-201'],
  );

  const hits = searchWorkspace(data, 'event-stream');
  assert.deepEqual(
    hits.tasks.map(t => t.key),
    ['PID-202'],
  );
});

test('diffWorkspacePatch and applyWorkspacePatch merge concurrent field, subtask, reaction, and colliding key edits', async () => {
  const { addComment, applyWorkspacePatch, diffWorkspacePatch } = await import('../../src/core/domain.js');
  const base = createDefaultState(FIXED_NOW);
  createProject(base.data, { name: 'Pi Durable', key: 'PID', status: 'active' }, { now: FIXED_NOW });
  const shared = createTask(base.data, { project: 'PID', title: 'Shared task', priority: 'medium' }, { now: FIXED_NOW });
  const s1 = addSubtask(base.data, shared.id, 'Subtask 1', { now: FIXED_NOW });
  const s2 = addSubtask(base.data, shared.id, 'Subtask 2', { now: FIXED_NOW });
  const c1 = addComment(base.data, shared.id, 'Looks good', { now: FIXED_NOW });
  c1.re = { '👍': ['m1'] };

  const serverState = structuredClone(base);
  const browserState = structuredClone(base);

  // Agent on server updates priority + completes s2 + creates PID-202 + creates project WEB.
  applyTaskPatch(serverState.data, shared.id, { priority: 'urgent' }, { now: FIXED_NOW + 100 });
  updateSubtask(serverState.data, shared.id, s2.id, { done: true }, { now: FIXED_NOW + 100 });
  createTask(serverState.data, { project: 'PID', title: 'Agent slice' }, { now: FIXED_NOW + 100 });
  createProject(serverState.data, { name: 'WebsiteServer', key: 'WEB' }, { now: FIXED_NOW + 100 });

  // Browser concurrently updates status + completes s1 + adds s3 + creates colliding PID-202 + colliding WEB/WEB-201 + toggles reaction & prefs.
  applyTaskPatch(browserState.data, shared.id, { status: 'progress' }, { now: FIXED_NOW + 200 });
  updateSubtask(browserState.data, shared.id, s1.id, { done: true }, { now: FIXED_NOW + 200 });
  addSubtask(browserState.data, shared.id, 'Subtask 3', { now: FIXED_NOW + 200 });
  const browserTask = createTask(browserState.data, { project: 'PID', title: 'Browser slice' }, { now: FIXED_NOW + 200 });
  assert.equal(browserTask.key, 'PID-202');
  const browserProj = createProject(browserState.data, { name: 'WebsiteLocal', key: 'WEB' }, { now: FIXED_NOW + 200 });
  const browserWebTask = createTask(browserState.data, { project: browserProj.id, title: 'Offline web task' }, { now: FIXED_NOW + 200 });
  assert.equal(browserWebTask.key, 'WEB-201');
  browserState.data.comments.find(c => c.id === c1.id).re['🎉'] = ['m1'];
  browserState.prefs.theme = 'dark';
  browserState.views = { p1: { layout: 'board' } };

  const patch = diffWorkspacePatch(base, browserState);
  const { rekeyed } = applyWorkspacePatch(serverState, patch);
  assert.equal(rekeyed, true);

  const mergedShared = serverState.data.tasks.find(t => t.id === shared.id);
  assert.equal(mergedShared.priority, 'urgent');
  assert.equal(mergedShared.status, 'progress');
  assert.equal(mergedShared.subtasks.find(s => s.id === s1.id).done, true);
  assert.equal(mergedShared.subtasks.find(s => s.id === s2.id).done, true);
  assert.equal(mergedShared.subtasks.length, 3);

  const pidTasks = serverState.data.tasks.filter(t => t.project === base.data.projects.find(p => p.key === 'PID').id);
  assert.deepEqual(
    pidTasks.map(t => `${t.key}:${t.title}`),
    ['PID-201:Shared task', 'PID-202:Agent slice', 'PID-203:Browser slice'],
  );

  const mergedBrowserProj = serverState.data.projects.find(p => p.id === browserProj.id);
  assert.equal(mergedBrowserProj.key, 'WEBX');
  assert.equal(serverState.data.tasks.find(t => t.id === browserWebTask.id).key, 'WEBX-201');
  assert.deepEqual(serverState.data.comments.find(c => c.id === c1.id).re, { '👍': ['m1'], '🎉': ['m1'] });
  assert.equal(serverState.prefs.theme, 'dark');
  assert.deepEqual(serverState.views, { p1: { layout: 'board' } });

  // Prototype-pollution keys in untrusted JSON patches are ignored safely.
  applyWorkspacePatch(serverState, JSON.parse('{"prefs":{"set":{"__proto__":{"polluted":true}}}}'));
  assert.equal({}.polluted, undefined);

  // Deleting tasks or projects that own comments (or concurrent deletion) succeeds without 404,
  // and activity histories larger than 1000 entries are preserved intact without silent truncation.
  const delBase = createDefaultState(FIXED_NOW);
  delBase.data.activity = Array.from({ length: 1200 }, (_, i) => ({
    id: `a_seed_${i}`,
    by: 'm1',
    verb: 'updated task',
    task: null,
    project: null,
    at: FIXED_NOW - i,
    extra: '',
  }));
  const pDel = createProject(delBase.data, { name: 'Cleanup', key: 'CLN' }, { now: FIXED_NOW });
  const tDel1 = createTask(delBase.data, { project: pDel.id, title: 'Has comments' }, { now: FIXED_NOW });
  const tDel2 = createTask(delBase.data, { project: pDel.id, title: 'Project cascade' }, { now: FIXED_NOW });
  addComment(delBase.data, tDel1.id, 'Comment A', { now: FIXED_NOW });
  addComment(delBase.data, tDel2.id, 'Comment B', { now: FIXED_NOW });

  const delServer = structuredClone(delBase);
  const delBrowser = structuredClone(delBase);
  const { deleteProject, deleteTasks } = await import('../../src/core/domain.js');
  // Server already deleted tDel1 concurrently while browser deletes both tDel1 and project CLN + logs new activity.
  deleteTasks(delServer.data, [tDel1.id]);
  deleteTasks(delBrowser.data, [tDel1.id]);
  deleteProject(delBrowser.data, pDel.id);
  applyTaskPatch(delBrowser.data, delBrowser.data.tasks[0].id, { status: 'done' }, { now: FIXED_NOW + 500 });

  const delPatch = diffWorkspacePatch(delBase, delBrowser);
  applyWorkspacePatch(delServer, delPatch);
  assert.equal(
    delServer.data.projects.some(p => p.id === pDel.id),
    false,
  );
  assert.equal(delServer.data.comments.length, 0);
  assert.ok(delServer.data.activity.length > 1200);

  // Concurrent addDeps on server while browser moves or archives the dependency target cleans dependents' deps.
  const depBase = createDefaultState(FIXED_NOW);
  const pAlp = createProject(depBase.data, { name: 'Alpha', key: 'ALP' }, { now: FIXED_NOW });
  const pBet = createProject(depBase.data, { name: 'Beta', key: 'BET' }, { now: FIXED_NOW });
  const tMove = createTask(depBase.data, { project: pBet.id, title: 'Moved target' }, { now: FIXED_NOW });
  const tArch = createTask(depBase.data, { project: pBet.id, title: 'Archived target' }, { now: FIXED_NOW });
  const tDependent = createTask(depBase.data, { project: pBet.id, title: 'Dependent task' }, { now: FIXED_NOW });

  const depServer = structuredClone(depBase);
  const depBrowser = structuredClone(depBase);
  applyTaskPatch(depServer.data, tDependent.id, { addDeps: [tMove.id, tArch.id] }, { now: FIXED_NOW + 100 });
  applyTaskPatch(depBrowser.data, tMove.id, { project: pAlp.id }, { now: FIXED_NOW + 200 });
  applyTaskPatch(depBrowser.data, tArch.id, { archived: true }, { now: FIXED_NOW + 200 });

  applyWorkspacePatch(depServer, diffWorkspacePatch(depBase, depBrowser));
  assert.deepEqual(depServer.data.tasks.find(t => t.id === tDependent.id).deps, []);

  // Single-patch order independence: when dependent C precedes target B in data.tasks and one patch
  // moves B into C's project and links C -> B, C.deps retains [B] without premature per-entry stripping.
  const singleBase = createDefaultState(FIXED_NOW);
  const sAlp = createProject(singleBase.data, { name: 'Alpha', key: 'ALP' }, { now: FIXED_NOW });
  const sBet = createProject(singleBase.data, { name: 'Beta', key: 'BET' }, { now: FIXED_NOW });
  const taskC = createTask(singleBase.data, { project: sAlp.id, title: 'Created first (dependent)' }, { now: FIXED_NOW });
  const taskB = createTask(singleBase.data, { project: sBet.id, title: 'Created second (target)' }, { now: FIXED_NOW + 10 });
  const singleServer = structuredClone(singleBase);
  const singleBrowser = structuredClone(singleBase);
  applyTaskPatch(singleBrowser.data, taskB.id, { project: sAlp.id }, { now: FIXED_NOW + 100 });
  applyTaskPatch(singleBrowser.data, taskC.id, { addDeps: [taskB.id] }, { now: FIXED_NOW + 200 });
  const singleRes = applyWorkspacePatch(singleServer, diffWorkspacePatch(singleBase, singleBrowser));
  assert.equal(singleRes.rekeyed, false);
  assert.deepEqual(singleServer.data.tasks.find(t => t.id === taskC.id).deps, [taskB.id]);

  // Same-patch move task T (with comment + file) out of project P into newly created project Q, then delete P:
  // T, its comment, and its file survive in Q without being cascade-deleted by deleteProject(P).
  const rescueBase = createDefaultState(FIXED_NOW);
  const pOld = createProject(rescueBase.data, { name: 'Old Project', key: 'OLD' }, { now: FIXED_NOW });
  const rescuedTask = createTask(rescueBase.data, { project: pOld.id, title: 'Rescue me' }, { now: FIXED_NOW });
  const rescuedComment = addComment(rescueBase.data, rescuedTask.id, 'Keep this comment', { now: FIXED_NOW });
  rescueBase.data.files.push({ id: 'f_rescue', name: 'spec.md', project: pOld.id, task: rescuedTask.id });

  const rescueServer = structuredClone(rescueBase);
  const rescueBrowser = structuredClone(rescueBase);
  const pDest = createProject(rescueBrowser.data, { name: 'Fresh Home', key: 'OLD_NEXT' }, { now: FIXED_NOW + 50 });
  applyTaskPatch(rescueBrowser.data, rescuedTask.id, { project: pDest.id }, { now: FIXED_NOW + 100 });
  rescueBrowser.data.files.find(f => f.id === 'f_rescue').project = pDest.id;
  deleteProject(rescueBrowser.data, pOld.id);

  const rescueOut = applyWorkspacePatch(rescueServer, diffWorkspacePatch(rescueBase, rescueBrowser));
  assert.equal(rescueOut.rekeyed, false);
  assert.equal(
    rescueServer.data.projects.some(p => p.id === pOld.id),
    false,
  );
  assert.equal(rescueServer.data.tasks.find(t => t.id === rescuedTask.id)?.project, pDest.id);
  assert.equal(
    rescueServer.data.comments.some(c => c.id === rescuedComment.id),
    true,
  );
  assert.equal(rescueServer.data.files.find(f => f.id === 'f_rescue')?.project, pDest.id);

  // Creating a savedView on project P, deleting P in the same patch, then undoing and renaming the savedView
  // keeps client and server in sync throughout without dropping the savedView.
  const svBase = createDefaultState(FIXED_NOW);
  const pView = createProject(svBase.data, { name: 'View Host', key: 'VWH' }, { now: FIXED_NOW });
  const svServer = structuredClone(svBase);
  const svBrowser = structuredClone(svBase);
  svBrowser.data.savedViews.push({ id: 'sv_1', name: 'Triage', project: pView.id, layout: 'board', filters: {} });
  const undoSnapshot = structuredClone(svBrowser);
  deleteProject(svBrowser.data, pView.id);
  assert.equal(svBrowser.data.savedViews.length, 0);

  applyWorkspacePatch(svServer, diffWorkspacePatch(svBase, svBrowser));
  assert.equal(
    svServer.data.projects.some(p => p.id === pView.id),
    false,
  );
  assert.equal(svServer.data.savedViews.length, 0);

  // Undo restores both project VWH and savedView sv_1, then renaming sv_1 propagates cleanly to server.
  applyWorkspacePatch(svServer, diffWorkspacePatch(svBrowser, undoSnapshot));
  assert.equal(svServer.data.savedViews.find(v => v.id === 'sv_1')?.name, 'Triage');
  const renamedBrowser = structuredClone(undoSnapshot);
  renamedBrowser.data.savedViews.find(v => v.id === 'sv_1').name = 'Bug Triage';
  const renameOut = applyWorkspacePatch(svServer, diffWorkspacePatch(undoSnapshot, renamedBrowser));
  assert.equal(renameOut.rekeyed, false);
  assert.equal(svServer.data.savedViews.find(v => v.id === 'sv_1')?.name, 'Bug Triage');
});

test('syncGitHubPullRequests handles draft/ready/merge, stacked (1/n) PRs, Refs vs Closes, prose safety, and idempotency', async () => {
  const { applyTaskPatch, createDefaultState, createProject, createTask, duplicateTask, searchWorkspace, syncGitHubPullRequests } =
    await import('../../src/core/domain.js');
  const state = createDefaultState(FIXED_NOW);
  const pid = createProject(state.data, { name: 'Pi Durable', key: 'PID', status: 'active' }, { now: FIXED_NOW });
  const t1 = createTask(state.data, { project: pid.id, title: 'Slice 1', status: 'backlog' }, { now: FIXED_NOW });
  const t2 = createTask(state.data, { project: pid.id, title: 'Slice 2 (untouched)', status: 'todo' }, { now: FIXED_NOW });
  const t3 = createTask(state.data, { project: pid.id, title: 'Slice 3 (referenced)', status: 'backlog' }, { now: FIXED_NOW });

  // 1. Draft PR on branch feat/pid-201-part1 moves backlog -> progress; prose/code mentions of PID-202 are ignored; Refs PID-203 links non-closing.
  const r1 = syncGitHubPullRequests(
    state.data,
    [
      {
        repo: 'fitchmultz/pi-durable',
        number: 101,
        title: 'Ledger schema (1/2)',
        headRef: 'feat/pid-201-ledger',
        body: 'Avoids colliding with PID-202.\n```\nCloses PID-202\n```\nRefs PID-203',
        state: 'OPEN',
        draft: true,
        updatedAt: '2026-11-15T01:00:00Z',
      },
    ],
    { now: FIXED_NOW + 100 },
  );
  assert.equal(r1.changed, true);
  assert.equal(t1.status, 'progress');
  assert.equal(t2.status, 'todo');
  assert.equal(t2.prs.length, 0);
  assert.equal(t3.status, 'progress');
  assert.equal(t3.prs[0].closing, false);

  // Repeated identical sync is a strict no-op.
  const noop = syncGitHubPullRequests(
    state.data,
    [
      {
        repo: 'fitchmultz/pi-durable',
        number: 101,
        title: 'Ledger schema (1/2)',
        headRef: 'feat/pid-201-ledger',
        body: 'Avoids colliding with PID-202.\n```\nCloses PID-202\n```\nRefs PID-203',
        state: 'open',
        draft: true,
        updatedAt: '2026-11-15T01:00:00Z',
      },
    ],
    { now: FIXED_NOW + 200 },
  );
  assert.equal(noop.changed, false);

  // 2. Marking PR #101 ready moves PID-201 to review; stale older event is ignored.
  syncGitHubPullRequests(
    state.data,
    {
      repo: 'fitchmultz/pi-durable',
      number: 101,
      title: 'Ledger schema (1/2)',
      headRef: 'feat/pid-201-ledger',
      body: 'Refs PID-203',
      state: 'open',
      draft: false,
      updatedAt: '2026-11-15T01:05:00Z',
    },
    { now: FIXED_NOW + 300 },
  );
  assert.equal(t1.status, 'review');

  const stale = syncGitHubPullRequests(
    state.data,
    {
      repo: 'fitchmultz/pi-durable',
      number: 101,
      title: 'Ledger schema (1/2)',
      headRef: 'feat/pid-201-ledger',
      body: 'Refs PID-203',
      state: 'open',
      draft: true,
      updatedAt: '2026-11-15T01:01:00Z',
    },
    { now: FIXED_NOW + 350 },
  );
  assert.equal(stale.changed, false);
  assert.equal(t1.prs[0].draft, false);

  // 3. Merging part (1/2) alone keeps PID-201 in review (incomplete stack) and keeps Refs-only PID-203 open.
  syncGitHubPullRequests(
    state.data,
    {
      repo: 'fitchmultz/pi-durable',
      number: 101,
      title: 'Ledger schema (1/2)',
      headRef: 'feat/pid-201-ledger',
      body: 'Refs PID-203',
      state: 'MERGED',
      merged: true,
      updatedAt: '2026-11-15T01:10:00Z',
    },
    { now: FIXED_NOW + 400 },
  );
  assert.equal(t1.status, 'review');
  assert.equal(t3.status, 'progress');

  // 4. Merging part (2/2) completes the stack and marks PID-201 done; duplicating PID-201 does not copy PR links.
  syncGitHubPullRequests(
    state.data,
    {
      repo: 'fitchmultz/pi-durable',
      number: 102,
      title: 'Ledger UI (2/2) (PID-201)',
      headRef: 'feat/ledger-ui',
      body: '',
      state: 'merged',
      merged: true,
      updatedAt: '2026-11-15T01:15:00Z',
    },
    { now: FIXED_NOW + 500 },
  );
  assert.equal(t1.status, 'done');
  assert.equal(t1.prs.length, 2);
  assert.equal(searchWorkspace(state.data, 'pi-durable#102').tasks[0]?.id, t1.id);

  const dup = duplicateTask(state.data, t1.id, { now: FIXED_NOW + 600 });
  assert.deepEqual(dup.prs, []);

  // 5. Prior non-stacked merged PR does not prematurely complete a later follow-up (1/2) stack;
  //    and completing a recurring task via PR merge spawns the next occurrence with prs: [].
  const tRecur = createTask(state.data, { project: pid.id, title: 'Weekly audit', status: 'todo', recur: 'Weekly', due: '2026-11-18' }, { now: FIXED_NOW });
  syncGitHubPullRequests(
    state.data,
    {
      repo: 'fitchmultz/pi-durable',
      number: 201,
      title: `Initial audit (${tRecur.key})`,
      state: 'merged',
      merged: true,
      createdAt: '2026-11-15T01:00:00Z',
      updatedAt: '2026-11-15T01:20:00Z',
    },
    { now: FIXED_NOW + 700 },
  );
  assert.equal(tRecur.status, 'done');
  const nextOcc = state.data.tasks.find(x => x.id !== tRecur.id && x.title === 'Weekly audit');
  assert.ok(nextOcc);
  assert.deepEqual(nextOcc.prs, []);

  // Follow-up stacked PR (1/2) created after completion reopens tRecur -> review, and merging (1/2) alone keeps it in review.
  syncGitHubPullRequests(
    state.data,
    {
      repo: 'fitchmultz/pi-durable',
      number: 202,
      title: `Audit follow-up (1/2) (${tRecur.key})`,
      state: 'open',
      draft: false,
      createdAt: '2026-11-15T02:00:00Z',
      updatedAt: '2026-11-15T02:00:00Z',
    },
    { now: FIXED_NOW + 800 },
  );
  assert.equal(tRecur.status, 'review');
  syncGitHubPullRequests(
    state.data,
    {
      repo: 'fitchmultz/pi-durable',
      number: 202,
      title: `Audit follow-up (1/2) (${tRecur.key})`,
      state: 'merged',
      merged: true,
      createdAt: '2026-11-15T02:00:00Z',
      updatedAt: '2026-11-15T02:10:00Z',
    },
    { now: FIXED_NOW + 900 },
  );
  assert.equal(tRecur.status, 'review');

  // 6. Prior completed (1/2)+(2/2) stack whose (2/2) later gets a comment/label updatedAt bump (and CLI flag-shape
  //    new (1/2) without createdAt) still keeps a new follow-up (1/2) incomplete until its own (2/2) merges.
  syncGitHubPullRequests(
    state.data,
    {
      repo: 'fitchmultz/pi-durable',
      number: 203,
      title: `Audit follow-up (2/2) (${tRecur.key})`,
      state: 'merged',
      merged: true,
      createdAt: '2026-11-15T02:05:00Z',
      updatedAt: '2026-11-15T02:20:00Z',
    },
    { now: FIXED_NOW + 1000 },
  );
  assert.equal(tRecur.status, 'done');

  // Open new stack C (1/2), then bump old #203 (2/2) updatedAt via post-merge comment/label, then merge C (1/2).
  syncGitHubPullRequests(
    state.data,
    {
      repo: 'fitchmultz/pi-durable',
      number: 210,
      title: `Second stack (1/2) (${tRecur.key})`,
      state: 'open',
      draft: false,
      createdAt: '2026-11-15T03:00:00Z',
      updatedAt: '2026-11-15T03:00:00Z',
    },
    { now: FIXED_NOW + 1100 },
  );
  assert.equal(tRecur.status, 'review');
  syncGitHubPullRequests(
    state.data,
    {
      repo: 'fitchmultz/pi-durable',
      number: 203,
      title: `Audit follow-up (2/2) (${tRecur.key})`,
      state: 'merged',
      merged: true,
      createdAt: '2026-11-15T02:05:00Z',
      updatedAt: '2026-11-15T03:05:00Z',
    },
    { now: FIXED_NOW + 1200 },
  );
  syncGitHubPullRequests(
    state.data,
    {
      repo: 'fitchmultz/pi-durable',
      number: 210,
      title: `Second stack (1/2) (${tRecur.key})`,
      state: 'merged',
      merged: true,
      createdAt: '2026-11-15T03:00:00Z',
      updatedAt: '2026-11-15T03:10:00Z',
    },
    { now: FIXED_NOW + 1300 },
  );
  assert.equal(tRecur.status, 'review');

  // Also verify timestamp-less CLI shape on a reopened task with a pre-existing merged (2/2).
  applyTaskPatch(state.data, t1.id, { status: 'review' }, { now: FIXED_NOW + 1400 });
  syncGitHubPullRequests(
    state.data,
    {
      repo: 'fitchmultz/pi-durable',
      number: 150,
      title: `CLI flag stack (1/2) (${t1.key})`,
      state: 'merged',
      merged: true,
    },
    { now: FIXED_NOW + 1400 },
  );
  assert.equal(t1.status, 'review');

  // Backfilling a prior cycle's (2/2) without timestamps after a new follow-up (1/2) is already open
  // does not synthesize a fake mergedAt that prematurely completes the follow-up (1/2) on merge.
  const tBackfill = createTask(state.data, { project: pid.id, title: 'Backfill order guard', status: 'todo' }, { now: FIXED_NOW });
  syncGitHubPullRequests(
    state.data,
    {
      repo: 'fitchmultz/pi-durable',
      number: 303,
      title: `Follow-up (1/2) (${tBackfill.key})`,
      state: 'open',
      draft: false,
      createdAt: '2026-11-15T03:00:00Z',
      updatedAt: '2026-11-15T03:00:00Z',
    },
    { now: Date.parse('2026-11-15T12:00:00Z') },
  );
  assert.equal(tBackfill.status, 'review');
  syncGitHubPullRequests(
    state.data,
    {
      repo: 'fitchmultz/pi-durable',
      number: 302,
      title: `Prior cycle (2/2) (${tBackfill.key})`,
      state: 'merged',
      merged: true,
    },
    { now: Date.parse('2026-11-15T12:00:20Z') },
  );
  syncGitHubPullRequests(
    state.data,
    {
      repo: 'fitchmultz/pi-durable',
      number: 303,
      title: `Follow-up (1/2) (${tBackfill.key})`,
      state: 'merged',
      merged: true,
      createdAt: '2026-11-15T03:00:00Z',
      updatedAt: '2026-11-15T03:10:00Z',
    },
    { now: Date.parse('2026-11-15T12:00:40Z') },
  );
  assert.equal(tBackfill.status, 'review');

  // 7. Stale webhook redelivery after a newer body edit unlinked KEY-123 does not re-link the PR or flip status.
  const tUnlink = createTask(state.data, { project: pid.id, title: 'Unlink redelivery guard', status: 'todo' }, { now: FIXED_NOW });
  const openWithKey = {
    repo: 'fitchmultz/pi-durable',
    number: 401,
    title: 'Refactor router',
    body: `Closes ${tUnlink.key}`,
    state: 'open',
    draft: false,
    updatedAt: '2026-11-15T01:00:00Z',
  };
  syncGitHubPullRequests(state.data, openWithKey, { now: FIXED_NOW + 2000 });
  assert.equal(tUnlink.status, 'review');
  assert.equal(tUnlink.prs.length, 1);

  syncGitHubPullRequests(state.data, { ...openWithKey, body: 'Removed accidental task ref', updatedAt: '2026-11-15T01:05:00Z' }, { now: FIXED_NOW + 2100 });
  assert.equal(tUnlink.prs.length, 0);
  applyTaskPatch(state.data, tUnlink.id, { status: 'todo' }, { now: FIXED_NOW + 2200 });

  const staleRedelivery = syncGitHubPullRequests(state.data, openWithKey, { now: FIXED_NOW + 2300 });
  assert.equal(staleRedelivery.changed, false);
  assert.equal(tUnlink.prs.length, 0);
  assert.equal(tUnlink.status, 'todo');

  // 8. Re-syncing a timestamp-less prior (2/2) with a late updatedAt does not turn it into a new stack's completion;
  //    and syncing same-stack #4 (2/2) merged without timestamps before #3 (1/2) merges still completes the stack.
  const tLate = createTask(state.data, { project: pid.id, title: 'Late updatedAt guard', status: 'todo' }, { now: FIXED_NOW });
  syncGitHubPullRequests(
    state.data,
    { repo: 'fitchmultz/pi-durable', number: 2, title: `Prior (2/2) (${tLate.key})`, state: 'merged', merged: true },
    { now: Date.parse('2026-11-14T10:00:00Z') },
  );
  assert.equal(tLate.status, 'done');
  syncGitHubPullRequests(
    state.data,
    {
      repo: 'fitchmultz/pi-durable',
      number: 3,
      title: `Follow-up (1/2) (${tLate.key})`,
      state: 'open',
      draft: false,
      createdAt: '2026-11-15T01:00:00Z',
      updatedAt: '2026-11-15T01:00:00Z',
    },
    { now: Date.parse('2026-11-15T01:00:00Z') },
  );
  assert.equal(tLate.status, 'review');
  syncGitHubPullRequests(
    state.data,
    {
      repo: 'fitchmultz/pi-durable',
      number: 2,
      title: `Prior (2/2) (${tLate.key})`,
      state: 'merged',
      merged: true,
      updatedAt: '2026-11-15T02:00:00Z',
    },
    { now: Date.parse('2026-11-15T02:00:00Z') },
  );
  syncGitHubPullRequests(
    state.data,
    {
      repo: 'fitchmultz/pi-durable',
      number: 3,
      title: `Follow-up (1/2) (${tLate.key})`,
      state: 'merged',
      merged: true,
      createdAt: '2026-11-15T01:00:00Z',
      updatedAt: '2026-11-15T02:30:00Z',
    },
    { now: Date.parse('2026-11-15T02:30:00Z') },
  );
  assert.equal(tLate.status, 'review');
  // Backfilling the prior PR's historical mergedAt (< follow-up createdAt) after the follow-up (1/2) merged stays review.
  syncGitHubPullRequests(
    state.data,
    {
      repo: 'fitchmultz/pi-durable',
      number: 2,
      title: `Prior (2/2) (${tLate.key})`,
      state: 'merged',
      merged: true,
      mergedAt: '2026-11-14T10:00:00Z',
      updatedAt: '2026-11-15T03:00:00Z',
    },
    { now: Date.parse('2026-11-15T03:00:00Z') },
  );
  assert.equal(tLate.status, 'review');

  // Out-of-order same-cycle #6 (2/2) synced merged without timestamps while #5 (1/2) is open completes when #5 merges.
  const tOutOrder = createTask(state.data, { project: pid.id, title: 'Out-of-order (2/2) first', status: 'todo' }, { now: FIXED_NOW });
  syncGitHubPullRequests(
    state.data,
    {
      repo: 'fitchmultz/pi-durable',
      number: 5,
      title: `Stack part A (1/2) (${tOutOrder.key})`,
      state: 'open',
      draft: false,
      createdAt: '2026-11-15T01:00:00Z',
      updatedAt: '2026-11-15T01:00:00Z',
    },
    { now: Date.parse('2026-11-15T01:00:00Z') },
  );
  syncGitHubPullRequests(
    state.data,
    { repo: 'fitchmultz/pi-durable', number: 6, title: `Stack part B (2/2) (${tOutOrder.key})`, state: 'merged', merged: true },
    { now: Date.parse('2026-11-15T02:00:00Z') },
  );
  assert.equal(tOutOrder.status, 'review');
  syncGitHubPullRequests(
    state.data,
    {
      repo: 'fitchmultz/pi-durable',
      number: 5,
      title: `Stack part A (1/2) (${tOutOrder.key})`,
      state: 'merged',
      merged: true,
      createdAt: '2026-11-15T01:00:00Z',
      updatedAt: '2026-11-15T03:00:00Z',
    },
    { now: Date.parse('2026-11-15T03:00:00Z') },
  );
  assert.equal(tOutOrder.status, 'done');

  // Current-cycle cross-repo (2/2) first synced without timestamps and later re-synced with real mergedAt >= (1/2) createdAt completes the stack.
  const tCross = createTask(state.data, { project: pid.id, title: 'Cross-repo mergedAt backfill', status: 'todo' }, { now: FIXED_NOW });
  syncGitHubPullRequests(
    state.data,
    {
      repo: 'acme/front',
      number: 10,
      title: `Feature UI (1/2) (${tCross.key})`,
      state: 'open',
      draft: false,
      createdAt: '2026-11-15T01:00:00Z',
      updatedAt: '2026-11-15T01:00:00Z',
    },
    { now: Date.parse('2026-11-15T01:00:00Z') },
  );
  syncGitHubPullRequests(
    state.data,
    { repo: 'acme/back', number: 20, title: `Feature API (2/2) (${tCross.key})`, state: 'merged', merged: true },
    { now: Date.parse('2026-11-15T02:00:00Z') },
  );
  syncGitHubPullRequests(
    state.data,
    {
      repo: 'acme/front',
      number: 10,
      title: `Feature UI (1/2) (${tCross.key})`,
      state: 'merged',
      merged: true,
      createdAt: '2026-11-15T01:00:00Z',
      updatedAt: '2026-11-15T03:00:00Z',
    },
    { now: Date.parse('2026-11-15T03:00:00Z') },
  );
  assert.equal(tCross.status, 'review');
  syncGitHubPullRequests(
    state.data,
    {
      repo: 'acme/back',
      number: 20,
      title: `Feature API (2/2) (${tCross.key})`,
      state: 'merged',
      merged: true,
      mergedAt: '2026-11-15T02:30:00Z',
      updatedAt: '2026-11-15T04:00:00Z',
    },
    { now: Date.parse('2026-11-15T04:00:00Z') },
  );
  assert.equal(tCross.status, 'done');

  // Cross-repo stack whose (1/2) was synced merged without timestamps at 03:00 completes when (2/2) syncs at 03:05 with mergedAt 02:30.
  const tCrossCli = createTask(state.data, { project: pid.id, title: 'Cross-repo timestamp-less partial', status: 'todo' }, { now: FIXED_NOW });
  syncGitHubPullRequests(
    state.data,
    { repo: 'acme/front', number: 30, title: `Feature UI (1/2) (${tCrossCli.key})`, state: 'merged', merged: true },
    { now: Date.parse('2026-11-15T03:00:00Z') },
  );
  assert.equal(tCrossCli.status, 'progress');
  syncGitHubPullRequests(
    state.data,
    {
      repo: 'acme/back',
      number: 40,
      title: `Feature API (2/2) (${tCrossCli.key})`,
      state: 'merged',
      merged: true,
      mergedAt: '2026-11-15T02:30:00Z',
      updatedAt: '2026-11-15T02:31:00Z',
    },
    { now: Date.parse('2026-11-15T03:05:00Z') },
  );
  assert.equal(tCrossCli.status, 'done');

  // Cross-repo stack whose (1/2) opens without timestamps, (2/2) merges while (1/2) is open, then (1/2) merges without timestamps reaches done.
  const tCrossOpenCli = createTask(state.data, { project: pid.id, title: 'Cross-repo open CLI partial', status: 'todo' }, { now: FIXED_NOW });
  syncGitHubPullRequests(
    state.data,
    { repo: 'acme/front', number: 50, title: `Feature UI (1/2) (${tCrossOpenCli.key})`, state: 'open', draft: false },
    { now: Date.parse('2026-11-15T03:10:00Z') },
  );
  syncGitHubPullRequests(
    state.data,
    { repo: 'acme/back', number: 60, title: `Feature API (2/2) (${tCrossOpenCli.key})`, state: 'merged', merged: true },
    { now: Date.parse('2026-11-15T03:15:00Z') },
  );
  assert.equal(tCrossOpenCli.status, 'review');
  syncGitHubPullRequests(
    state.data,
    { repo: 'acme/front', number: 50, title: `Feature UI (1/2) (${tCrossOpenCli.key})`, state: 'merged', merged: true },
    { now: Date.parse('2026-11-15T03:20:00Z') },
  );
  assert.equal(tCrossOpenCli.status, 'done');

  // Timestamp-less cross-repo backfill of a prior (2/2) after a timestamped follow-up (1/2) merged stays review until a real mergedAt >= createdAt arrives.
  const tCrossBackfill = createTask(state.data, { project: pid.id, title: 'Cross-repo timestamp-less backfill guard', status: 'todo' }, { now: FIXED_NOW });
  syncGitHubPullRequests(
    state.data,
    {
      repo: 'acme/front',
      number: 70,
      title: `Follow-up UI (1/2) (${tCrossBackfill.key})`,
      state: 'open',
      draft: false,
      createdAt: '2026-11-15T01:00:00Z',
      updatedAt: '2026-11-15T01:00:00Z',
    },
    { now: Date.parse('2026-11-15T01:00:00Z') },
  );
  syncGitHubPullRequests(
    state.data,
    {
      repo: 'acme/front',
      number: 70,
      title: `Follow-up UI (1/2) (${tCrossBackfill.key})`,
      state: 'merged',
      merged: true,
      createdAt: '2026-11-15T01:00:00Z',
      mergedAt: '2026-11-15T02:00:00Z',
      updatedAt: '2026-11-15T02:00:00Z',
    },
    { now: Date.parse('2026-11-15T02:00:00Z') },
  );
  assert.equal(tCrossBackfill.status, 'review');
  syncGitHubPullRequests(
    state.data,
    { repo: 'acme/back', number: 5, title: `Prior cycle (2/2) (${tCrossBackfill.key})`, state: 'merged', merged: true },
    { now: Date.parse('2026-11-15T03:00:00Z') },
  );
  assert.equal(tCrossBackfill.status, 'review');

  // Timestamp-less cross-repo (1/2) opened and merged on 11-15 stays review when a prior-cycle (2/2) with 11-14 mergedAt is linked afterward.
  const tCrossPrior = createTask(
    state.data,
    { project: pid.id, title: 'Cross-repo prior mergedAt guard', status: 'todo', recur: 'Weekly', due: '2026-11-18' },
    { now: FIXED_NOW },
  );
  const tasksBefore = state.data.tasks.length;
  syncGitHubPullRequests(
    state.data,
    { repo: 'acme/front', number: 80, title: `Feature UI (1/2) (${tCrossPrior.key})`, state: 'open', draft: false },
    { now: Date.parse('2026-11-15T03:00:00Z') },
  );
  syncGitHubPullRequests(
    state.data,
    { repo: 'acme/front', number: 80, title: `Feature UI (1/2) (${tCrossPrior.key})`, state: 'merged', merged: true },
    { now: Date.parse('2026-11-15T03:05:00Z') },
  );
  assert.equal(tCrossPrior.status, 'review');
  syncGitHubPullRequests(
    state.data,
    {
      repo: 'acme/back',
      number: 8,
      title: `Prior cycle (2/2) (${tCrossPrior.key})`,
      state: 'merged',
      merged: true,
      mergedAt: '2026-11-14T10:00:00Z',
      updatedAt: '2026-11-15T03:10:00Z',
    },
    { now: Date.parse('2026-11-15T03:15:00Z') },
  );
  assert.equal(tCrossPrior.status, 'review');
  assert.equal(state.data.tasks.length, tasksBefore);
});

test('canceled status excludes tasks from open/overdue counts and progress denominator without counting as done', () => {
  const state = createDefaultState(FIXED_NOW);
  const p = createProject(state.data, { name: 'Cancelation Semantics', key: 'CAN' }, { now: FIXED_NOW });
  const tDone = createTask(state.data, { project: p.id, title: 'Shipped slice', status: 'done' }, { now: FIXED_NOW });
  const tTodo = createTask(state.data, { project: p.id, title: 'Superseded slice', status: 'progress', due: '2026-11-10' }, { now: FIXED_NOW });

  assert.equal(isTaskOverdue(tTodo, FIXED_NOW), true);
  assert.equal(projectProgress(state.data, p.id), 50);

  // Cancel via British spelling alias as well to prevent agent spelling errors.
  applyTaskPatch(state.data, tTodo, { status: 'cancelled' }, { now: FIXED_NOW + 100 });
  assert.equal(tTodo.status, 'canceled');
  assert.equal(tTodo.canceledAt, FIXED_NOW + 100);
  assert.equal(tTodo.prevStatus, 'progress');
  assert.equal(isTaskOverdue(tTodo, FIXED_NOW + 100), false);

  // Canceled tasks are not open, not overdue, and excluded from progress denominator.
  const apiProj = formatProjectForApi(state.data, p, FIXED_NOW + 100);
  assert.equal(apiProj.taskCount, 2);
  assert.equal(apiProj.doneCount, 1);
  assert.equal(apiProj.canceledCount, 1);
  assert.equal(apiProj.openCount, 0);
  assert.equal(apiProj.overdueCount, 0);
  assert.equal(apiProj.progress, 100);

  assert.deepEqual(
    queryTasks(state.data, { project: p.id, status: 'open' }, { now: FIXED_NOW + 100 }).map(t => t.key),
    [],
  );
  assert.deepEqual(
    queryTasks(state.data, { project: p.id, status: 'canceled' }, { now: FIXED_NOW + 100 }).map(t => t.key),
    [tTodo.key],
  );
  assert.deepEqual(
    queryTasks(state.data, { project: p.id, status: 'done' }, { now: FIXED_NOW + 100 }).map(t => t.key),
    [tDone.key],
  );

  // Reopening clears canceledAt.
  applyTaskPatch(state.data, tTodo, { status: 'todo' }, { now: FIXED_NOW + 200 });
  assert.equal(tTodo.canceledAt, null);
  assert.equal(projectProgress(state.data, p.id), 50);

  // Timestamp-less or updatedAt-only merge syncs do not overwrite an explicit cancellation;
  // only an explicit mergedAt after canceledAt completes the task.
  syncGitHubPullRequests(state.data, { repo: 'acme/app', number: 12, title: `feat: attempt (${tTodo.key})`, state: 'open' }, { now: FIXED_NOW + 1000 });
  applyTaskPatch(state.data, tTodo, { status: 'canceled' }, { now: FIXED_NOW + 2000 });
  syncGitHubPullRequests(
    state.data,
    { repo: 'acme/app', number: 12, title: `feat: attempt (${tTodo.key})`, state: 'merged', merged: true },
    { now: FIXED_NOW + 3000 },
  );
  assert.equal(tTodo.status, 'canceled');
  assert.equal(tTodo.canceledAt, FIXED_NOW + 2000);

  // Resyncing PR #12 with an authoritative mergedAt older than canceledAt keeps the task canceled.
  syncGitHubPullRequests(
    state.data,
    {
      repo: 'acme/app',
      number: 12,
      title: `feat: attempt (${tTodo.key})`,
      state: 'merged',
      merged: true,
      mergedAt: new Date(FIXED_NOW + 1500).toISOString(),
    },
    { now: FIXED_NOW + 3500 },
  );
  assert.equal(tTodo.status, 'canceled');
  assert.equal(tTodo.canceledAt, FIXED_NOW + 2000);

  // Resyncing PR #15 with an authoritative mergedAt after canceledAt completes the task even after an earlier timestamp-less merge.
  const tResync = createTask(state.data, { project: p.id, title: 'Resync slice', status: 'progress' }, { now: FIXED_NOW });
  syncGitHubPullRequests(state.data, { repo: 'acme/app', number: 15, title: `feat: resync (${tResync.key})`, state: 'open' }, { now: FIXED_NOW + 1000 });
  applyTaskPatch(state.data, tResync, { status: 'canceled' }, { now: FIXED_NOW + 2000 });
  syncGitHubPullRequests(
    state.data,
    { repo: 'acme/app', number: 15, title: `feat: resync (${tResync.key})`, state: 'merged', merged: true },
    { now: FIXED_NOW + 3000 },
  );
  assert.equal(tResync.status, 'canceled');
  syncGitHubPullRequests(
    state.data,
    {
      repo: 'acme/app',
      number: 15,
      title: `feat: resync (${tResync.key})`,
      state: 'merged',
      merged: true,
      mergedAt: new Date(FIXED_NOW + 2500).toISOString(),
    },
    { now: FIXED_NOW + 4000 },
  );
  assert.equal(tResync.status, 'done');
  assert.equal(tResync.prs.find(x => x.number === 15)?.mergedAt, FIXED_NOW + 2500);

  // Deliberately reopened tasks with a pre-existing merged link lacking mergedAtExact stay reopened on timestamped resync.
  const tReopened = createTask(
    state.data,
    { project: p.id, title: 'Reopened recurring slice', status: 'done', recur: 'Weekly', due: '2026-11-20' },
    { now: FIXED_NOW },
  );
  tReopened.prs = [
    {
      repo: 'acme/app',
      number: 16,
      title: `feat: legacy (${tReopened.key})`,
      url: 'https://github.com/acme/app/pull/16',
      headRef: 'feat/legacy',
      state: 'merged',
      draft: false,
      closing: true,
      updatedAt: FIXED_NOW + 500,
      linkedSeq: 1,
      mergedSeq: 1,
      mergedAt: FIXED_NOW + 500,
    },
  ];
  applyTaskPatch(state.data, tReopened, { status: 'todo' }, { now: FIXED_NOW + 1000 });
  const countBeforeResync = state.data.tasks.length;
  syncGitHubPullRequests(
    state.data,
    {
      repo: 'acme/app',
      number: 16,
      title: `feat: legacy (${tReopened.key})`,
      state: 'merged',
      merged: true,
      mergedAt: new Date(FIXED_NOW + 500).toISOString(),
      updatedAt: new Date(FIXED_NOW + 6000).toISOString(),
    },
    { now: FIXED_NOW + 6000 },
  );
  assert.equal(tReopened.status, 'todo');
  assert.equal(state.data.tasks.length, countBeforeResync);

  // Two-PR canceled task: closing PR #80 merges after canceledAt while sibling PR #81 is still open;
  // once #81 closes unmerged, the deferred post-cancel merge completes the task deterministically.
  const tSibling = createTask(state.data, { project: p.id, title: 'Sibling PR slice', status: 'progress' }, { now: FIXED_NOW });
  syncGitHubPullRequests(
    state.data,
    [
      { repo: 'acme/app', number: 80, title: `feat: attempt A (${tSibling.key})`, state: 'open' },
      { repo: 'acme/app', number: 81, title: `feat: attempt B (${tSibling.key})`, state: 'open' },
    ],
    { now: FIXED_NOW + 500 },
  );
  applyTaskPatch(state.data, tSibling, { status: 'canceled' }, { now: FIXED_NOW + 1000 });
  syncGitHubPullRequests(
    state.data,
    {
      repo: 'acme/app',
      number: 80,
      title: `feat: attempt A (${tSibling.key})`,
      state: 'merged',
      merged: true,
      mergedAt: new Date(FIXED_NOW + 1800).toISOString(),
      updatedAt: new Date(FIXED_NOW + 2000).toISOString(),
    },
    { now: FIXED_NOW + 2000 },
  );
  assert.equal(tSibling.status, 'canceled');
  syncGitHubPullRequests(
    state.data,
    {
      repo: 'acme/app',
      number: 81,
      title: `feat: attempt B (${tSibling.key})`,
      state: 'closed',
      merged: false,
      updatedAt: new Date(FIXED_NOW + 3000).toISOString(),
    },
    { now: FIXED_NOW + 3000 },
  );
  assert.equal(tSibling.status, 'done');

  syncGitHubPullRequests(
    state.data,
    {
      repo: 'acme/app',
      number: 13,
      title: `feat: superseded (${tTodo.key})`,
      state: 'merged',
      merged: true,
      updatedAt: new Date(FIXED_NOW + 4000).toISOString(),
    },
    { now: FIXED_NOW + 4000 },
  );
  assert.equal(tTodo.status, 'canceled');

  syncGitHubPullRequests(
    state.data,
    {
      repo: 'acme/app',
      number: 14,
      title: `feat: replacement (${tTodo.key})`,
      state: 'merged',
      merged: true,
      mergedAt: new Date(FIXED_NOW + 5000).toISOString(),
    },
    { now: FIXED_NOW + 5000 },
  );
  assert.equal(tTodo.status, 'done');
});

test('custom workspace labels and parent/child sub-issues enforce cycle, cascade, and concurrent patch invariants', () => {
  const state = createDefaultState(FIXED_NOW);
  // Simulate a pre-migration workspace without data.labels on disk.
  delete state.data.labels;
  const baseSnap = structuredClone(state);
  ensureLabels(state.data);
  // Pure lazy initialization emits no spurious workspace diff.
  assert.deepEqual(diffWorkspacePatch(baseSnap, state), {});

  const infra = createLabel(state.data, { name: 'Infra', color: 'indigo' });
  assert.equal(infra.id, 'infra');
  assert.throws(() => createLabel(state.data, { name: 'infra' }), DomainError);
  assert.throws(() => createLabel(state.data, { name: 'Poison', color: 'constructor' }), DomainError);
  assert.throws(() => createLabel(state.data, { id: 'prototype', name: 'Bad Explicit Id' }), DomainError);
  updateLabel(state.data, 'Infra', { name: 'Infrastructure', color: '#2288dd' });
  assert.equal(infra.c, '#2288DD');

  // Ordinary label names like "Prototype" get a safe non-colliding id and survive diff/applyWorkspacePatch.
  const protoSnap = structuredClone(state);
  const protoLbl = createLabel(state.data, { name: 'Prototype', color: 'teal' });
  assert.equal(protoLbl.id, 'label-prototype');
  const protoSynced = structuredClone(protoSnap);
  applyWorkspacePatch(protoSynced, diffWorkspacePatch(protoSnap, state));
  assert.equal(resolveLabel(protoSynced.data, 'Prototype')?.id, 'label-prototype');

  const p = createProject(state.data, { name: 'Agent Hierarchy', key: 'AGH' }, { now: FIXED_NOW });
  const pOther = createProject(state.data, { name: 'Other Project', key: 'OTH' }, { now: FIXED_NOW });
  const epic = createTask(state.data, { project: p.id, title: 'Epic: Linear Parity', labels: ['Infrastructure'] }, { now: FIXED_NOW });
  assert.deepEqual(epic.labels, ['infra']);

  const childA = createTask(state.data, { project: p.id, parent: epic.key, title: 'Slice A', status: 'done' }, { now: FIXED_NOW });
  const childB = createTask(state.data, { project: p.id, parent: epic.id, title: 'Slice B', status: 'todo' }, { now: FIXED_NOW });
  const childCanceled = createTask(state.data, { project: p.id, parent: epic.id, title: 'Canceled slice', status: 'canceled' }, { now: FIXED_NOW });

  // Self-parent, ancestor cycles, and cross-project parents are rejected.
  assert.throws(() => applyTaskPatch(state.data, epic, { parent: epic.id }), DomainError);
  assert.throws(() => applyTaskPatch(state.data, epic, { parent: childA.id }), DomainError);
  const otherTask = createTask(state.data, { project: pOther.id, title: 'Foreign task' }, { now: FIXED_NOW });
  assert.throws(() => applyTaskPatch(state.data, childA, { parent: otherTask.id }), DomainError);

  const epicApi = formatTaskForApi(state.data, epic);
  assert.equal(epicApi.childCount, 2);
  assert.equal(epicApi.childDoneCount, 1);
  assert.equal(formatTaskForApi(state.data, childA).parentKey, epic.key);

  assert.deepEqual(
    queryTasks(state.data, { project: p.id, parent: epic.key }).map(t => t.key),
    [childA.key, childB.key, childCanceled.key],
  );
  assert.deepEqual(
    queryTasks(state.data, { project: p.id, parent: 'none' }).map(t => t.key),
    [epic.key],
  );

  // Promoting a subtask attaches it as a child sub-issue of the parent task.
  const sub = addSubtask(state.data, childB, 'Promoted piece', { now: FIXED_NOW });
  const promoted = promoteSubtask(state.data, childB, sub.id, { now: FIXED_NOW });
  assert.equal(promoted.parent, childB.id);

  // Duplicating a project remaps parent links across copied tasks.
  const pDup = duplicateProject(state.data, p, { now: FIXED_NOW });
  const dupTasks = queryTasks(state.data, { project: pDup.id });
  const dupEpic = dupTasks.find(t => t.title === epic.title);
  const dupChildA = dupTasks.find(t => t.title === childA.title);
  assert.equal(dupChildA.parent, dupEpic.id);

  // Moving a parent task to another project detaches children left behind; deleting a label strips it from tasks.
  const preDeleteSnap = structuredClone(state);
  state.views = { [`p:${p.id}`]: { filters: [{ f: 'labels', op: 'is', v: ['infra'] }] } };
  state.data.savedViews.push({ id: 'sv-infra', name: 'Infra only', project: p.id, filters: [{ f: 'labels', op: 'is', v: ['infra'] }] });
  deleteLabel(state.data, 'infra', { views: state.views });
  assert.deepEqual(epic.labels, []);
  assert.deepEqual(state.views[`p:${p.id}`].filters, []);
  assert.deepEqual(state.data.savedViews.find(v => v.id === 'sv-infra').filters, []);
  const offlineClient = structuredClone(preDeleteSnap);
  offlineClient.data.savedViews.push({
    id: 'sv-offline',
    name: 'Offline infra',
    project: p.id,
    filters: [{ f: 'labels', op: 'is', v: ['infra', 'bug'] }],
  });
  offlineClient.views = { [`p:${p.id}`]: { filters: [{ f: 'labels', op: 'is', v: ['infra'] }] } };
  applyWorkspacePatch(state, diffWorkspacePatch(preDeleteSnap, offlineClient));
  assert.deepEqual(state.data.savedViews.find(v => v.id === 'sv-offline').filters, [{ f: 'labels', op: 'is', v: ['bug'] }]);
  assert.deepEqual(state.views[`p:${p.id}`].filters, []);
  applyTaskPatch(state.data, childB, { project: pOther.id }, { now: FIXED_NOW });
  assert.equal(childB.parent, null);
  assert.equal(promoted.parent, null);

  // Concurrent offline cycle (A.parent = B and B.parent = A) is sanitized on applyWorkspacePatch.
  assert.equal(childrenOfTask(state.data, epic.id).length, 2);
  const tab2 = structuredClone(state);
  const res = applyWorkspacePatch(tab2, {
    tasks: {
      updated: {
        [epic.id]: { fields: { set: { parent: childA.id } } },
      },
    },
  });
  assert.equal(res.rekeyed, true);
  assert.equal(Boolean(tab2.data.tasks.find(x => x.id === epic.id).parent && tab2.data.tasks.find(x => x.id === childA.id).parent), false);
  deleteTasks(state.data, [epic.id]);
  assert.equal(childA.parent, null);
});

test('agent claims, --ready queue ordering, dependency unblocking, and claim cleanup enforce multi-agent invariants', () => {
  const state = createDefaultState(FIXED_NOW);
  const p = createProject(state.data, { name: 'Swarm Queue', key: 'SWM' }, { now: FIXED_NOW });
  const blocker = createTask(state.data, { project: p.id, title: 'Step 1: Schema', priority: 'medium', status: 'todo' }, { now: FIXED_NOW });
  const blocked = createTask(state.data, { project: p.id, title: 'Step 2: API', priority: 'urgent', status: 'todo', deps: [blocker.key] }, { now: FIXED_NOW });
  const urgentReady = createTask(state.data, { project: p.id, title: 'Hotfix', priority: 'high', status: 'todo' }, { now: FIXED_NOW });

  assert.equal(isTaskBlocked(state.data, blocked), true);
  assert.equal(isTaskReady(state.data, blocked), false);
  assert.equal(isTaskReady(state.data, blocker), true);

  // --ready orders urgent/high before medium and excludes blocked tasks.
  assert.deepEqual(
    queryTasks(state.data, { project: p.id, ready: true, status: 'open' }).map(t => t.key),
    [urgentReady.key, blocker.key],
  );

  // Claiming a blocked task without --force fails with 409.
  assert.throws(() => claimTask(state.data, blocked, { agent: 'pi:worker-1', now: FIXED_NOW + 10 }), DomainError);

  // claimNextReadyTask atomically claims the highest-priority ready slice.
  const firstClaimed = claimNextReadyTask(state.data, { project: p.id }, { agent: 'pi:worker-1', now: FIXED_NOW + 20 });
  assert.equal(firstClaimed.key, urgentReady.key);
  assert.equal(firstClaimed.status, 'progress');
  assert.equal(firstClaimed.claimedBy, 'pi:worker-1');

  // Idempotent re-claim by the same agent succeeds; competing agent gets 409 unless --force.
  assert.equal(claimTask(state.data, urgentReady, { agent: 'pi:worker-1', now: FIXED_NOW + 30 }).claimedBy, 'pi:worker-1');
  assert.throws(() => claimTask(state.data, urgentReady, { agent: 'pi:worker-2', now: FIXED_NOW + 40 }), DomainError);
  assert.equal(claimTask(state.data, urgentReady, { agent: 'pi:worker-2', force: true, now: FIXED_NOW + 50 }).claimedBy, 'pi:worker-2');

  // Next worker gets blocker; third worker sees empty queue (null).
  const secondClaimed = claimNextReadyTask(state.data, { project: p.id }, { agent: 'pi:worker-3', now: FIXED_NOW + 60 });
  assert.equal(secondClaimed.key, blocker.key);
  assert.equal(claimNextReadyTask(state.data, { project: p.id }, { agent: 'pi:worker-4', now: FIXED_NOW + 70 }), null);

  // Completing blocker clears its claim AND unblocks Step 2 in the ready queue.
  applyTaskPatch(state.data, blocker, { status: 'done' }, { agent: 'pi:worker-3', now: FIXED_NOW + 80 });
  assert.equal(blocker.claimedBy, null);
  assert.equal(isTaskReady(state.data, blocked), true);

  const cmt = addComment(state.data, blocked, 'Ready to start', { agent: 'pi:worker-4', now: FIXED_NOW + 90 });
  assert.equal(cmt.agent, 'pi:worker-4');

  // Explicit release returns task to todo and clears claim.
  releaseTask(state.data, urgentReady, { status: 'todo', agent: 'pi:worker-2', now: FIXED_NOW + 100 });
  assert.equal(urgentReady.claimedBy, null);
  assert.equal(urgentReady.status, 'todo');

  // Fractional drag-drop orders sort numerically in --ready, and concurrent todo patches scrub claims.
  const pOrder = createProject(state.data, { name: 'Order Tie-Break', key: 'ORD' }, { now: FIXED_NOW });
  const ordA = createTask(state.data, { project: pOrder.id, title: 'Ord 5', priority: 'medium', status: 'todo', order: 5 }, { now: FIXED_NOW });
  const midDrag = createTask(state.data, { project: pOrder.id, title: 'Ord 5.001', priority: 'medium', status: 'todo', order: 5.001 }, { now: FIXED_NOW });
  const lateInt = createTask(state.data, { project: pOrder.id, title: 'Ord 6', priority: 'medium', status: 'todo', order: 6 }, { now: FIXED_NOW });
  createTask(state.data, { project: pOrder.id, title: 'In review', priority: 'urgent', status: 'review' }, { now: FIXED_NOW });
  assert.deepEqual(
    queryTasks(state.data, { project: pOrder.id, ready: true, status: 'open' }).map(t => t.key),
    [ordA.key, midDrag.key, lateInt.key],
  );
  claimTask(state.data, midDrag, { agent: 'pi:worker-9', now: FIXED_NOW + 110 });
  applyWorkspacePatch(state, { tasks: { updated: { [midDrag.id]: { fields: { set: { status: 'todo' } } } } } });
  assert.equal(midDrag.claimedBy, null);
  assert.equal(isTaskReady(state.data, midDrag), true);

  const sub = addSubtask(state.data, ordA, 'Wire subtask attribution', { agent: 'pi:worker-9', now: FIXED_NOW + 120 });
  updateSubtask(state.data, ordA, sub.id, { assignee: 'me', due: '2026-12-01' }, { agent: 'pi:worker-9', now: FIXED_NOW + 121 });
  assert.equal(state.data.activity[0].agent, 'pi:worker-9');
  assert.equal(state.data.activity[1].agent, 'pi:worker-9');
});
