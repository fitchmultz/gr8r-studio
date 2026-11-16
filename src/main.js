/* =====================================================================
   ENTRY: styles, then every module in dependency order (several register
   global listeners or add handlers to the action table when they load), then boot.
   ===================================================================== */
import './styles/index.css';
import './core/utils.js';
import './core/icons.js';
import './core/constants.js';
import './data/seed.js';
import './core/store.js';
import './ui/helpers.js';
import './core/theme.js';
import './ui/toast.js';
import './ui/select.js';
import './shell/render.js';
import './shell/layout.js';
import './shell/skeletons.js';
import './shell/view-engine.js';
import './components/task-list.js';
import './pages/home.js';
import './pages/overview.js';
import './pages/my-tasks.js';
import './pages/tasks.js';
import './pages/inbox.js';
import './pages/notifications.js';
import './pages/favorites.js';
import './pages/projects.js';
import './pages/members.js';
import './pages/activity.js';
import './pages/search.js';
import './pages/errors.js';
import './pages/project.js';
import './views/project-overview.js';
import './views/board.js';
import './views/table.js';
import './views/calendar.js';
import './views/timeline.js';
import './views/files.js';
import './overlays/drawer.js';
import './overlays/modals.js';
import './overlays/popovers.js';
import './overlays/context-menu.js';
import './overlays/palette.js';
import './pages/settings.js';
import './pages/design-system.js';
import './actions/actions.js';
import './actions/events.js';
import './actions/keyboard.js';
import './actions/drag-drop.js';
import './features/teams.js';
import './features/subtasks.js';
import './features/archive.js';
import './actions/teams.js';
import './actions/subtasks.js';
import './actions/archive.js';
import { initSync, isSyncEnabled } from './core/sync.js';
import { S, D, getRev } from './core/store.js';
import { A } from './actions/actions.js';
import { applyHashRoute, buildRouteHash, consumeProgrammaticHash, go, render } from './shell/render.js';

(function init() {
  document.documentElement.lang = 'en';
  if (!document.getElementById('sr-live')) {
    const l = document.createElement('div');
    l.id = 'sr-live';
    l.className = 'sr';
    l.setAttribute('aria-live', 'polite');
    document.body.appendChild(l);
  }
  const parsed = applyHashRoute({ initial: true });
  if (parsed.empty) {
    history.replaceState(null, '', buildRouteHash(S.ui.route, S.ui.params));
  } else if (parsed.unresolved && isSyncEnabled() && getRev() === 0) {
    S.ui.loading = true;
  }
  render();
  initSync();
})();

window.addEventListener('hashchange', () => {
  if (consumeProgrammaticHash(location.hash)) return;
  applyHashRoute({ fromHash: true });
  render();
});

document.addEventListener(
  'error',
  e => {
    if (e.target instanceof HTMLImageElement && e.target.matches('img[data-fprev-img]')) {
      e.target.style.display = 'none';
    }
  },
  true,
);

document.addEventListener('click', e => {
  if (e.button !== 0) return;
  const a = e.target.closest?.('.rte-body a[href]');
  if (!a) return;
  const inEditor = !!a.closest('[contenteditable="true"]');
  const modified = e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
  if (!inEditor && modified) return;
  const href = a.getAttribute('href') || '';
  if (!/^https?:\/\//i.test(href)) {
    e.preventDefault();
    return;
  }
  const sel = window.getSelection?.();
  if (sel && !sel.isCollapsed) return;
  e.preventDefault();
  window.open(href, '_blank', 'noopener,noreferrer');
});

// Dev-only handle for debugging and screenshot tooling; stripped from production builds.
if (import.meta.env.DEV) window.__gr8r = { S, D, A, go, render };
