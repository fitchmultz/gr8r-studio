import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToMarkdown, markdownToHtml, stripHtml } from '../../src/core/markdown.js';
import {
  DomainError,
  addComment,
  addSubtask,
  applyTaskPatch,
  createDefaultState,
  createProject,
  createTask,
  deleteProject,
  deleteTasks,
  duplicateProject,
  duplicateTask,
  promoteSubtask,
  queryTasks,
  removeMember,
  removeSubtask,
  searchWorkspace,
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
});
