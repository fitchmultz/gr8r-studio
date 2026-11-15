/* =====================================================================
   ACTIONS · ARCHIVE: restore and purge
   ===================================================================== */
import { esc } from '../core/utils.js';
import { D, task } from '../core/store.js';
import { applyTaskPatch } from '../core/domain.js';
import { mutate, toast } from '../ui/toast.js';
import { A, confirmDlg, deleteTasks } from './actions.js';

A.restoreTask = el => {
  const t = task(el.dataset.id);
  if (
    mutate(() => {
      applyTaskPatch(D(), t, { archived: false }, { by: D().me });
    })
  )
    toast(`Restored “${t.title}”`, { action: 'Open', onAction: () => A.openTask({ dataset: { id: t.id } }) });
};
A.purgeTask = el => {
  const t = task(el.dataset.id);
  confirmDlg({
    title: 'Delete task permanently?',
    body: `<b>${esc(t.title)}</b>, its subtasks, comments, and attachments will be deleted for everyone. This can't be undone.`,
    ok: 'Delete permanently',
    danger: true,
    run: () => {
      if (mutate(() => deleteTasks([t.id]))) toast(`Deleted “${t.title}”`);
    },
  });
};
