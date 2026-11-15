/* ---------- PROJECT DOCS ---------- */
import { ago, esc } from '../core/utils.js';
import { ic } from '../core/icons.js';
import { docsOfProject } from '../core/domain.js';
import { markdownToHtml } from '../core/markdown.js';
import { D, S, mem } from '../core/store.js';
import { agentBadge, av, empty } from '../ui/helpers.js';

export function docsHtml(pid) {
  const docs = docsOfProject(D(), pid);
  const selId = S.ui.params.doc || S.ui.docSel?.[pid] || docs[0]?.id || null;
  const sel = docs.find(d => d.id === selId || d.slug === selId) || docs[0] || null;
  const isEditing = sel ? (S.ui.docEdit?.[sel.id] ?? !sel.body) : false;

  return `<div class="toolbar">
      <span class="muted" style="font-size:12.5px">${docs.length} document${docs.length === 1 ? '' : 's'}</span>
      <span class="sp"></span>
      <button class="btn btn-primary btn-sm" data-a="newDoc" data-project="${pid}">${ic('plus', 13)}New doc</button>
    </div>
    <div style="display:grid;grid-template-columns:minmax(220px,280px) minmax(0,1fr);flex:1;min-height:calc(100vh - 156px)" class="docs-grid">
      <style>@media(max-width:860px){.docs-grid{grid-template-columns:minmax(0,1fr)!important}}</style>
      <div style="border-right:1px solid var(--border);display:flex;flex-direction:column;min-height:0;overflow-y:auto">
        ${
          docs.length
            ? docs
                .map(
                  d => `<button class="row" style="width:100%;text-align:left;padding:10px 14px;border-bottom:1px solid var(--divider);gap:8px;background:${sel && sel.id === d.id ? 'var(--surface-2)' : 'transparent'}" data-a="selDoc" data-project="${pid}" data-id="${d.id}">
                  ${ic(d.pinned ? 'pin' : 'file-text', 14)}
                  <div class="grow" style="min-width:0">
                    <div class="trunc" style="font-weight:${sel && sel.id === d.id ? '600' : '500'};font-size:13px">${esc(d.title)}</div>
                    <div class="faint trunc" style="font-size:11.5px">${esc(d.slug)} · ${ago(d.updated)}</div>
                  </div>
                </button>`,
                )
                .join('')
            : `<div style="padding:22px 14px" class="faint">No docs yet.</div>`
        }
      </div>
      <div style="padding:24px 32px;overflow-y:auto;min-width:0">
        ${
          sel
            ? `<div style="max-width:780px">
                <div class="row" style="gap:8px;margin-bottom:10px;font-size:12px;color:var(--text-3)">
                  <span class="mono">${esc(sel.slug)}</span>
                  <span>·</span>
                  <span class="row" style="gap:5px">${av(sel.updatedBy || sel.by, 'xs', false)}Updated ${ago(sel.updated)} by ${esc(mem(sel.updatedBy || sel.by)?.name || 'Owner')}</span>
                  ${sel.agent ? agentBadge(sel.agent) : ''}
                  <span class="sp"></span>
                  <button class="btn btn-ghost btn-sm" data-a="toggleEditDoc" data-id="${sel.id}" aria-pressed="${isEditing}">${ic(isEditing ? 'eye' : 'edit-3', 13)}${isEditing ? 'Preview' : 'Edit'}</button>
                  <button class="btn btn-ghost btn-sm" data-a="togglePinDoc" data-id="${sel.id}" aria-pressed="${!!sel.pinned}">${ic('pin', 13)}${sel.pinned ? 'Pinned' : 'Pin'}</button>
                  <button class="ibtn ibtn-sm" data-a="deleteDoc" data-id="${sel.id}" aria-label="Delete doc" style="color:var(--red)">${ic('trash-2', 14)}</button>
                </div>
                <textarea class="ttl-edit" id="doc-title" rows="1" data-autosize data-blur="commitDocTitle" data-key-enter="blur" data-id="${sel.id}" aria-label="Document title" style="margin-bottom:14px">${esc(sel.title)}</textarea>
                ${
                  isEditing
                    ? `<textarea class="input mono" id="doc-body" data-in="docBody" data-id="${sel.id}" placeholder="Write Markdown (# headings, - lists, \`\`\` code fences, [links](https://…))…" aria-label="Document Markdown" style="width:100%;min-height:360px;line-height:1.6;padding:14px;font-size:13px;resize:vertical">${esc(sel.body || '')}</textarea>`
                    : `<div class="rte"><div class="rte-body" style="min-height:240px">${sel.body ? markdownToHtml(sel.body) : '<p class="faint">Empty document — click Edit to write Markdown.</p>'}</div></div>`
                }
              </div>`
            : empty(
                'file-text',
                'Project Docs',
                'Keep architecture specs, runbooks, and agent context right alongside project tasks.',
                `<button class="btn btn-primary btn-sm" data-a="newDoc" data-project="${pid}">${ic('plus', 13)}Create first doc</button>`,
              )
        }
      </div>
    </div>`;
}
