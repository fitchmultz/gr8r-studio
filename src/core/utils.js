/* =====================================================================
   QUIRE — core: utils, icons, seed data, store, render loop, events
   ===================================================================== */
import { DAY, MON, MONL, WD, WDL, addD, clamp, dOff, diffD, esc, formatDateWith, isIsoDate, iso, minsAgo, parse, sod, todayDate, uid } from './dates.js';

// Web fonts load without blocking first paint (the link starts as media=print).
document.querySelectorAll('link[data-font]').forEach(l => {
  l.media = 'all';
});
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? '⌘' : 'Ctrl';

/* ---------- dates ---------- */
export { DAY, MON, MONL, WD, WDL, addD, clamp, dOff, diffD, esc, formatDateWith, isIsoDate, iso, minsAgo, parse, sod, todayDate, uid };
export const TODAY = todayDate();
/* Set from preferences on every render (core/theme.js), so utils never depends on the store. */
export let dateFormat = 'MMM d';
export function setDateFormat(f) {
  dateFormat = f || 'MMM d';
}
export function fmtDate(s, long) {
  return formatDateWith(s, dateFormat, long, TODAY);
}
export function relDate(s) {
  if (!s) return '';
  const n = diffD(parse(s), TODAY);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  if (n > 1 && n < 7) return WD[parse(s).getDay()];
  return fmtDate(s);
}
export function ago(ts) {
  const m = Math.round((Date.now() - ts) / 6e4);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.round(h / 24);
  if (d < 7) return d + 'd ago';
  return fmtDate(iso(new Date(ts)));
}
export function dayBucket(ts) {
  const n = diffD(new Date(ts), TODAY);
  if (n === 0) return 'Today';
  if (n === -1) return 'Yesterday';
  if (n > -7) return 'This week';
  return 'Earlier';
}
