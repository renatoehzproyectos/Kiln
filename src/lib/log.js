/** Tiny in-memory debug log, shown in the UI and copyable. */
const lines = [];
const subs = new Set();
const t0 = () => new Date().toISOString().slice(11, 23);

export function log(msg) {
  lines.push(`${t0()} ${msg}`);
  if (lines.length > 5000) lines.splice(0, 1000);
  subs.forEach((f) => f());
}
export const logText = () => lines.join('\n');
export const logClear = () => { lines.length = 0; subs.forEach((f) => f()); };
export const logSub = (f) => subs.add(f);
