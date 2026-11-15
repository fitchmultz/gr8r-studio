/* =====================================================================
   ACTIONS · SUBTASKS: open, navigate, rename, notes, promote
   ===================================================================== */
import { $ } from '../core/utils.js';
import { D, S, save, task } from '../core/store.js';
import { promoteSubtask as domainPromoteSubtask, resolveSubtask, updateSubtask as domainUpdateSubtask } from '../core/domain.js';
import { mutate, toast } from '../ui/toast.js';
import { fxSet, render } from '../shell/render.js';
import { A, BLUR, IN } from './actions.js';

export const subOf = (t, sid) => resolveSubtask(t, sid);
A.openSub = el => {
  S.ui.subOpen = { tid: el.dataset.id, sid: el.dataset.sid };
  S.ui.pop = null;
  render();
  setTimeout(() => $('#s-title')?.focus(), 0);
};
A.closeSub = () => {
  S.ui.lastSub = S.ui.subOpen?.sid;
  S.ui.subOpen = null;
  render();
};
export const _rmSub = A.rmSub;
A.rmSub = el => {
  if (S.ui.subOpen?.sid === el.dataset.sid) {
    S.ui.subOpen = null;
  }
  _rmSub(el);
};
A.subNav = el => {
  const t = task(el.dataset.id);
  const i = t.subtasks.findIndex(s => s.id === S.ui.subOpen?.sid) + +el.dataset.d;
  if (t.subtasks[i]) {
    S.ui.subOpen = { tid: t.id, sid: t.subtasks[i].id };
    render();
  }
};
BLUR.commitSubTitle = el => {
  const t = task(el.dataset.id);
  const s = subOf(t, el.dataset.sid);
  const v = el.value.trim();
  if (s && v && v !== s.title)
    mutate(() => {
      domainUpdateSubtask(D(), t, s.id, { title: v }, { by: D().me });
    });
};
IN.subNote = el => {
  const t = task(el.dataset.id);
  const s = subOf(t, el.dataset.sid);
  if (s) {
    domainUpdateSubtask(D(), t, s.id, { note: el.value }, { by: D().me });
    save();
  }
};
A.promoteSub = el => {
  const t = task(el.dataset.id);
  const s = subOf(t, el.dataset.sid);
  if (!s) return;
  let n;
  if (
    !mutate(() => {
      n = domainPromoteSubtask(D(), t, s.id, { by: D().me });
      fxSet({ added: n.id });
    })
  )
    return;
  S.ui.subOpen = null;
  render();
  toast(`Converted to ${n.key}`, { action: 'Open', onAction: () => A.openTask({ dataset: { id: n.id } }) });
};
