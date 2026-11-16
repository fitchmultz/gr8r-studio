/* =====================================================================
   SHELL: render loop, router, sidebar, topbar, skeletons, filter engine
   ===================================================================== */
import { $, $$ } from '../core/utils.js';
import { TEAMS_SEED } from '../core/constants.js';
import { canSeeProject, resolveProject, resolveTask } from '../core/domain.js';
import { D, S, mem, proj, team } from '../core/store.js';
import { applyPrefs } from '../core/theme.js';
import { enhanceSelects, selectMenu } from '../ui/select.js';
import { renderShell } from './layout.js';
import { PTABS } from '../pages/project.js';
import { tlAfter } from '../views/timeline.js';
import { renderLayer } from '../overlays/drawer.js';
import { placePop } from '../overlays/popovers.js';

export const ROUTE_NAMES = {
  home: 'Home',
  inbox: 'Inbox',
  mytasks: 'My Tasks',
  favorites: 'Favorites',
  notifications: 'Notifications',
  search: 'Search',
  overview: 'Overview',
  projects: 'Projects',
  tasks: 'Tasks',
  calendar: 'Calendar',
  timeline: 'Timeline',
  members: 'Members',
  member: 'Member',
  teams: 'Teams',
  team: 'Team',
  activity: 'Activity',
  settings: 'Settings',
  system: 'Design system',
  states: 'System states',
  archive: 'Archive',
};
export const ROUTE_ICONS = {
  home: 'house',
  inbox: 'inbox',
  mytasks: 'circle-check',
  favorites: 'star',
  notifications: 'bell',
  search: 'search',
  overview: 'layout-dashboard',
  projects: 'folder-kanban',
  tasks: 'list-checks',
  calendar: 'calendar',
  timeline: 'chart-gantt',
  members: 'users',
  activity: 'activity',
  teams: 'users',
  settings: 'settings',
  system: 'component',
  states: 'layers',
  archive: 'archive',
};

let programmaticHash = null;
const safeSeg = s => encodeURIComponent(String(s ?? '')).replace(/%3A/gi, ':');

function decodeSeg(seg) {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

export function buildRouteHash(route, params = {}, drawerRef = null, data = D()) {
  if (drawerRef) {
    const ref = typeof drawerRef === 'object' ? drawerRef.key || drawerRef.id : (data ? resolveTask(data, drawerRef)?.key : null) || String(drawerRef);
    return `#/task/${safeSeg(ref)}`;
  }
  if (route === 'project') {
    const p = params?.id && data ? resolveProject(data, params.id) : null;
    const projRef = p?.key ? p.key.toLowerCase() : params?.id;
    if (!projRef) return '#/projects';
    const tab = params?.tab || 'board';
    if (tab === 'docs') {
      const pid = p?.id || params?.id;
      const docRef = params?.doc || S?.ui?.docSel?.[pid] || '';
      if (docRef) {
        const docObj = (data?.docs || []).find(d => d.project === pid && (d.id === docRef || d.slug === docRef));
        const docSeg = docObj?.slug || docObj?.id || docRef;
        return `#/project/${safeSeg(projRef)}/docs/${safeSeg(docSeg)}`;
      }
      return `#/project/${safeSeg(projRef)}/docs`;
    }
    if (tab === 'board') return `#/project/${safeSeg(projRef)}`;
    return `#/project/${safeSeg(projRef)}/${safeSeg(tab)}`;
  }
  if (route === 'member' && params?.id) return `#/member/${safeSeg(params.id)}`;
  if (route === 'team' && params?.id) return `#/team/${safeSeg(params.id)}`;
  if (route === 'settings' && params?.sec) return `#/settings/${safeSeg(params.sec)}`;
  if (ROUTE_NAMES[route]) return `#/${route}`;
  return '#/home';
}

export function parseRouteHash(hash, data = D()) {
  const raw = String(hash ?? '').replace(/^#/, '');
  if (!raw || raw === '/') return { empty: true, route: 'home', params: {}, drawer: null };
  const parts = raw.replace(/^\/+/, '').split('/').filter(Boolean).map(decodeSeg);
  if (!parts.length) return { empty: true, route: 'home', params: {}, drawer: null };
  const [headRaw, arg1, arg2, arg3] = parts;
  const head = headRaw.toLowerCase();

  if (head === 'project') {
    if (!arg1) return { route: 'projects', params: {}, drawer: null };
    const p = resolveProject(data, arg1);
    if (!p) return { route: '404', params: {}, drawer: null, unresolved: true };
    const tab = arg2 || 'board';
    const params = { id: p.id, tab };
    if (tab === 'docs' && arg3) {
      const doc = (data?.docs || []).find(d => d.project === p.id && (d.id === arg3 || d.slug === arg3));
      params.doc = doc ? doc.id : arg3;
    }
    return { route: 'project', params, drawer: null };
  }
  if (head === 'task') {
    if (!arg1) return { route: 'tasks', params: {}, drawer: null };
    const t = resolveTask(data, arg1);
    if (!t) return { route: '404', params: {}, drawer: null, unresolved: true };
    const p = resolveProject(data, t.project);
    const allowed = !p || canSeeProject(data, p, data?.me);
    return { route: 'project', params: { id: t.project, tab: 'board' }, drawer: allowed ? t.id : null };
  }
  if (head === 'member') {
    if (!arg1) return { route: 'members', params: {}, drawer: null };
    const m = (data?.members || []).find(x => x.id === arg1);
    if (!m) return { route: '404', params: {}, drawer: null, unresolved: true };
    return { route: 'member', params: { id: m.id }, drawer: null };
  }
  if (head === 'team') {
    if (!arg1) return { route: 'teams', params: {}, drawer: null };
    const tm = (data?.teams || TEAMS_SEED).find(x => x.id === arg1);
    if (!tm) return { route: '404', params: {}, drawer: null, unresolved: true };
    return { route: 'team', params: { id: tm.id }, drawer: null };
  }
  if (head === 'settings') {
    return { route: 'settings', params: arg1 ? { sec: arg1 } : {}, drawer: null };
  }
  if (ROUTE_NAMES[head] && !['project', 'member', 'team'].includes(head)) {
    return { route: head, params: {}, drawer: null };
  }
  return { route: '404', params: {}, drawer: null, unresolved: true };
}

export function consumeProgrammaticHash(hash) {
  return programmaticHash !== null && hash === programmaticHash;
}

export function syncHashToState(replace = false) {
  const nextHash = buildRouteHash(S.ui.route, S.ui.params);
  if (location.hash === nextHash) return;
  if (replace) {
    history.replaceState(null, '', nextHash);
  } else {
    programmaticHash = nextHash;
    location.hash = nextHash;
    setTimeout(() => {
      if (programmaticHash === nextHash) programmaticHash = null;
    }, 50);
  }
}

export function applyHashRoute(opt = {}) {
  if (opt.fromHash) programmaticHash = null;
  const parsed = parseRouteHash(location.hash, D());
  if (parsed.empty) {
    S.ui.route = opt.initial ? S.prefs.home || 'home' : 'home';
    S.ui.params = {};
    if (opt.fromHash) {
      S.ui.drawer = null;
      S.ui.drawerFull = false;
    }
    return parsed;
  }
  S.ui.route = parsed.route;
  S.ui.params = parsed.params;
  if (parsed.route === 'project' && parsed.params.tab === 'docs' && parsed.params.doc) {
    S.ui.docSel = S.ui.docSel || {};
    S.ui.docSel[parsed.params.id] = parsed.params.doc;
  }
  if (parsed.drawer) {
    S.ui.drawer = parsed.drawer;
    S.ui.drawerFull = S.prefs.openTasks === 'full';
  } else if (opt.fromHash) {
    S.ui.drawer = null;
    S.ui.drawerFull = false;
  }
  if (opt.fromHash) {
    S.ui.mnav = false;
    S.ui.pop = null;
    S.ui.palette = null;
    S.ui.modals = [];
    S.ui.sel.clear();
  }
  return parsed;
}

export function go(route, params = {}, opt = {}) {
  const nextParams = { ...params };
  if (route === 'project' && !nextParams.tab) nextParams.tab = 'board';
  if (!opt.back && !opt.fromHash) S.ui.history.push({ route: S.ui.route, params: S.ui.params });
  const same = S.ui.route === route && JSON.stringify(S.ui.params) === JSON.stringify(nextParams);
  S.ui.route = route;
  S.ui.params = nextParams;
  S.ui.mnav = false;
  S.ui.sel.clear();
  S.ui.pop = null;
  S.ui.composer = null;
  S.ui.editCell = null;
  if (!opt.keepDrawer && S.ui.drawer && innerWidth < 900) S.ui.drawer = null;
  // Pages render instantly; motion (not a fake wait) carries the transition.
  clearTimeout(go._t);
  S.ui.loading = false;
  if (!same) fxSet(opt.tab ? { tab: true, tabs: true } : { route: true, tabs: true });
  if (!opt.fromHash) syncHashToState(!!opt.replaceHash);
  render();
  const c = $('.content');
  if (c && !same) c.scrollTop = 0;
}

/* One-shot motion flags: read by templates during the next render, then cleared, so full re-renders never replay them. */
export const reduceMotion = () => S.prefs.motion === 'reduce' || (S.prefs.motion !== 'full' && matchMedia('(prefers-reduced-motion: reduce)').matches);
export function fxSet(o) {
  S.ui.fx = Object.assign(S.ui.fx || {}, o);
}
export const fxc = (kind, id) => (S.ui.fx && S.ui.fx[kind] === id ? ' fx-' + kind : '');
/* Focus survives full re-renders: every control is addressable by its data-* identity. */
export const FKEYS = ['a', 'id', 'r', 'tab', 'pop', 'ctx', 'k', 'v', 'sec', 'i', 'field', 'sid', 'key', 'e', 'f', 'dragCard', 'taskRow'];
export function focusKey(el) {
  if (!el || el === document.body || !el.tagName) return null;
  if (el.id) return '#' + CSS.escape(el.id);
  const d = el.dataset || {};
  const parts = FKEYS.filter(k => d[k] != null).map(k => `[data-${k.replace(/[A-Z]/g, m => '-' + m.toLowerCase())}="${CSS.escape(d[k])}"]`);
  return parts.length ? el.tagName.toLowerCase() + parts.join('') : null;
}
export function tryFocus(key) {
  if (!key) return false;
  let el;
  try {
    el = document.querySelector(key);
  } catch {
    return false;
  }
  if (el && el.offsetParent !== null) {
    el.focus({ preventScroll: true });
    return document.activeElement === el;
  }
  return false;
}
export function pageTitle() {
  const u = S.ui;
  let t = ROUTE_NAMES[u.route] || 'Not found';
  if (u.route === 'project' && proj(u.params.id)) t = `${(PTABS.find(x => x[0] === u.params.tab) || [0, 'Saved view'])[1]} · ${proj(u.params.id).name}`;
  if (u.route === 'member' && mem(u.params.id)) t = mem(u.params.id).name;
  if (u.route === 'team' && team(u.params.id)) t = team(u.params.id).name;
  return `${t} · ${D().ws.name}`;
}
/* Anything clickable is keyboard-reachable: non-native [data-a] controls get a role and a tab stop. */
export function makeFocusable() {
  for (const el of document.querySelectorAll('[data-a]:not(button):not(a):not(input):not(label):not(select):not(textarea):not([tabindex])')) {
    if (el.matches('.scrim,.modal-wrap,.drawer-scrim,.side-scrim')) continue;
    el.tabIndex = 0;
    if (!el.hasAttribute('role')) el.setAttribute('role', el.dataset.a === 'go' ? 'link' : 'button');
  }
}
export function render() {
  applyPrefs();
  const prevOv = render._ov || {};
  const ov = { pop: !!S.ui.pop, modals: S.ui.modals.length, drawer: S.ui.drawer, pal: !!S.ui.palette, sub: !!S.ui.subOpen };
  // Entrances animate only on the render where the surface first appears.
  const fx = S.ui.fx || (S.ui.fx = {});
  if (ov.drawer && prevOv.drawer !== ov.drawer) fx.drawer = true;
  if (ov.modals > (prevOv.modals || 0)) fx.modal = ov.modals;
  const popSig = S.ui.pop ? [S.ui.pop.type, S.ui.pop.id, S.ui.pop.i, S.ui.pop.field, S.ui.pop.ctx, S.ui.pop.key].join('|') : '';
  if (popSig && popSig !== render._popSig) fx.pop = true;
  render._popSig = popSig;
  if (S.ui.sel.size && !render._selN) fx.bulk = true;
  render._selN = S.ui.sel.size;
  const a = document.activeElement;
  const fid = a && a.id;
  let s0 = null,
    s1 = null;
  const fkey = focusKey(a);
  try {
    s0 = a.selectionStart;
    s1 = a.selectionEnd;
  } catch {
    /* not supported here; safe to skip */
  }
  const keep = $$('[data-keep]').map(el => [el.dataset.keep, el.scrollTop, el.scrollLeft]);
  $('#app').innerHTML = renderShell();
  $('#layer').innerHTML = renderLayer();
  makeFocusable();
  keep.forEach(([k, t, l]) => {
    const el = document.querySelector(`[data-keep="${CSS.escape(k)}"]`);
    if (el) {
      el.scrollTop = t;
      el.scrollLeft = l;
    }
  });
  if (fid) {
    const el = document.getElementById(fid);
    if (el && el !== document.activeElement) {
      el.focus({ preventScroll: true });
      try {
        if (s0 != null) el.setSelectionRange(s0, s1);
      } catch {
        /* not supported here; safe to skip */
      }
    }
  }
  // Return focus to whatever opened a surface that just closed; otherwise keep the control that had it.
  const lost = () => !document.activeElement || document.activeElement === document.body;
  if (prevOv.modals > ov.modals) {
    const k = S.ui.modalOpeners.splice(ov.modals).shift();
    if (lost()) tryFocus(k);
  }
  if (prevOv.pop && !ov.pop && lost()) tryFocus(S.ui.popOpener);
  if (prevOv.drawer && !ov.drawer && lost()) tryFocus(S.ui.drawerOpener);
  if (prevOv.pal && !ov.pal && lost()) tryFocus(S.ui.palOpener);
  if (prevOv.sub && !ov.sub && lost()) tryFocus('.drawer .subt [data-sid="' + (S.ui.lastSub || '') + '"]');
  if (lost() && fkey) tryFocus(fkey);
  render._ov = ov;
  const played = S.ui.fx;
  S.ui.fx = {};
  if (played.route && !reduceMotion()) countUp();
  const title = pageTitle();
  if (document.title !== title) {
    document.title = title;
    const live = document.getElementById('sr-live');
    if (live && !S.ui.loading) live.textContent = title.split(' · ').slice(0, -1).join(', ');
  }
  afterRender();
}
export function afterRender() {
  selectMenu.close();
  enhanceSelects();
  placePop();
  $$('textarea[data-autosize]').forEach(autosize);
  const pal = $('#pal-in');
  if (pal && document.activeElement !== pal && !S.ui.pop) pal.focus();
  if ((S.ui.route === 'project' && S.ui.params.tab === 'timeline') || S.ui.route === 'timeline') tlAfter();
}
/* Headline numbers count up once when a dashboard is entered. */
export function countUp() {
  for (const el of document.querySelectorAll('.fx-route .stat .v')) {
    const m = el.textContent.match(/^(\d+)(%?)$/);
    if (!m) continue;
    const to = +m[1],
      suf = m[2];
    if (to < 2) continue;
    const t0 = performance.now(),
      dur = 520;
    const step = now => {
      const k = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      if (!el.isConnected) return;
      el.textContent = Math.round(to * e) + suf;
      if (k < 1) requestAnimationFrame(step);
    };
    el.textContent = '0' + suf;
    requestAnimationFrame(step);
  }
}
export function autosize(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}
