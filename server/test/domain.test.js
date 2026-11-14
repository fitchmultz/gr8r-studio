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
  promoteSubtask,
  queryTasks,
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
      desc: '#### Summary\n\nShip **UsageDoc** in `chat.ts`.',
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
