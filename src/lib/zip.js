import { unzipSync } from 'fflate';

const JUNK = /(^|\/)(__MACOSX|\.git)(\/|$)|(^|\/)\.DS_Store$/;

/** Unzip into a Map<path, Uint8Array>, skipping folders and OS junk. */
export async function readZip(file) {
  const raw = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const files = new Map();
  for (const [path, data] of Object.entries(raw)) {
    if (!path.endsWith('/') && !JUNK.test(path)) files.set(path, data);
  }
  return files;
}

/** Candidate roots. The first is auto-detected: we step into single wrapper folders. */
export function rootCandidates(files) {
  const paths = [...files.keys()];
  let auto = '';
  for (;;) {
    const kids = new Set();
    let loose = 0;
    for (const p of paths) {
      if (!p.startsWith(auto)) continue;
      const rest = p.slice(auto.length), i = rest.indexOf('/');
      i < 0 ? loose++ : kids.add(rest.slice(0, i + 1));
    }
    if (loose === 0 && kids.size === 1) auto += [...kids][0]; else break;
  }
  const dirs = new Set(['']);
  for (const p of paths) {
    const parts = p.split('/').slice(0, -1);
    for (let n = 1; n <= Math.min(parts.length, 3); n++) dirs.add(parts.slice(0, n).join('/') + '/');
  }
  return [auto, ...[...dirs].filter((d) => d !== auto).sort()];
}

/** Files under `root`, with the root prefix stripped. */
export function filesUnder(files, root) {
  const out = new Map();
  for (const [p, d] of files) if (p.startsWith(root)) out.set(p.slice(root.length), d);
  return out;
}
