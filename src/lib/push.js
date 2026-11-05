import { log } from './log.js';
import { inflight } from './github.js';

/** Two phases: plan() reads the repo and decides; execute() writes one commit, as few requests as possible. */

const hex = (h) => [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function gitSha(data) {
  const head = new TextEncoder().encode(`blob ${data.length}\0`);
  const buf = new Uint8Array(head.length + data.length);
  buf.set(head); buf.set(data, head.length);
  return hex(await crypto.subtle.digest('SHA-1', buf));
}

// Native base64 (FileReader runs off the JS thread); far faster than String.fromCharCode + btoa.
const toBase64 = (bytes) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result.slice(r.result.indexOf(',') + 1));
  r.onerror = () => reject(r.error);
  r.readAsDataURL(new Blob([bytes]));
});

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
/** Text we can send inline in a tree entry (no blob request). Returns null for binary. */
function asText(data) {
  if (data.length > 1_000_000 || data.includes(0)) return null;
  try { return utf8.decode(data); } catch { return null; }
}

export async function plan(gh, repo, files, mode) {
  const base = `/repos/${repo.full_name}`;
  const branch = repo.default_branch;
  let ref, tree;
  for (let i = 0; i < 4; i++) {  // a just-created repo can take a moment to appear
    try {
      // ref and tree in parallel: the branch name resolves to its tree directly.
      [ref, tree] = await Promise.all([
        gh.get(`${base}/git/ref/heads/${branch}`),
        gh.get(`${base}/git/trees/${encodeURIComponent(branch)}?recursive=1`),
      ]);
      break;
    } catch (e) {
      if (i === 3 || !repo.fresh) throw new Error('This repo has no commits yet. Add a README on GitHub first, then try again.');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  log(`plan: remote tree ${tree.tree.length} entries${tree.truncated ? ' (TRUNCATED)' : ''}, head ${ref.object.sha.slice(0, 7)}`);
  const remote = new Map(tree.tree.filter((t) => t.type === 'blob').map((t) => [t.path, t]));

  const entries = [...files];
  const shas = await Promise.all(entries.map(([, data]) => gitSha(data)));   // hash everything at once
  const upload = [], keep = [];
  entries.forEach(([path, data], i) => {
    const r = remote.get(path);
    if (r?.sha === shas[i]) keep.push({ path, sha: shas[i], mode: r.mode });
    else upload.push({ path, data, sha: shas[i], mode: r?.mode || '100644' });
  });
  log(`plan: ${upload.length} to upload, ${keep.length} unchanged`);
  const deletions = mode === 'replace' ? [...remote.keys()].filter((p) => !files.has(p)).sort() : [];
  return { base, branch, head: ref.object.sha, treeSha: tree.sha, mode, upload, keep, deletions,
           changes: upload.length + deletions.length };
}

const CONCURRENCY = 24;        // GitHub allows up to 100 concurrent requests; HTTP/2 multiplexes them
const INLINE_CHUNK = 3_000_000; // bytes of inline text per tree request (GitHub caps trees ~7 MB)

export async function execute(gh, p, message, onProgress) {
  const total = p.upload.length;
  let done = 0;
  const tick = (n = 1) => { done += n; onProgress(Math.min(done, total), total); };
  const t0 = performance.now();
  const watchdog = setInterval(() => {
    const now = performance.now(), open = [...inflight.values()].sort((a, b) => a.t - b.t);
    log(`watchdog: ${done}/${total} done, ${open.length} in flight` +
      (open.length ? `, oldest ${Math.round((now - open[0].t) / 1000)}s: ${open[0].tag} (${open[0].kb}KB)` : ''));
  }, 5000);
  try { return await run(); } finally { clearInterval(watchdog); log(`execute finished after ${Math.round(performance.now() - t0)}ms`); }
  async function run() {

  // Split: text goes inline in tree entries; binary needs a blob. Identical content is uploaded once.
  const inline = [], binary = [], seen = new Map();
  for (const f of p.upload) {
    const text = asText(f.data);
    if (text !== null) inline.push({ path: f.path, mode: f.mode, type: 'blob', content: text, size: f.data.length });
    else if (seen.has(f.sha)) seen.get(f.sha).paths.push(f);
    else { const g = { f, paths: [f] }; seen.set(f.sha, g); binary.push(g); }
  }

  log(`execute: ${inline.length} inline text files, ${binary.length} blobs (${p.upload.length - inline.length - binary.length} duplicates)`);

  // Binary: one blob each, in parallel.
  const blobEntries = [];
  const blobsDone = pool(binary, CONCURRENCY, async ({ f, paths }) => {
    const b = await gh.post(`${p.base}/git/blobs`, { content: await toBase64(f.data), encoding: 'base64' });
    if (done % 50 === 0) log(`blob progress ${done}/${total}`);
    for (const x of paths) blobEntries.push({ path: x.path, mode: x.mode, type: 'blob', sha: b.sha });
    tick(paths.length);
  });

  // Text: a handful of tree requests chained on base_tree, running while the blobs upload.
  const textDone = (async () => {
    let tree = p.treeSha;
    const chunks = [];
    let cur = [], size = 0;
    for (const e of inline) {
      if (size + e.size > INLINE_CHUNK && cur.length) { chunks.push(cur); cur = []; size = 0; }
      cur.push(e); size += e.size;
    }
    if (cur.length) chunks.push(cur);
    for (const c of chunks) {
      const t = await gh.post(`${p.base}/git/trees`, {
        base_tree: tree, tree: c.map(({ size: _s, ...e }) => e),
      });
      tree = t.sha; tick(c.length);
    }
    return tree;
  })();

  const [baseTree] = await Promise.all([textDone, blobsDone]);

  // Final tree: the blob entries plus deletions (Replace mode), on top of the text-chain tree.
  const last = [...blobEntries, ...p.deletions.map((path) => ({ path, mode: '100644', type: 'blob', sha: null }))];
  const treeSha = last.length ? (await gh.post(`${p.base}/git/trees`, { base_tree: baseTree, tree: last })).sha : baseTree;
  const c = await gh.post(`${p.base}/git/commits`, { message, tree: treeSha, parents: [p.head] });
  await gh.patch(`${p.base}/git/refs/heads/${p.branch}`, { sha: c.sha });
  log(`commit ${c.sha.slice(0, 7)} pushed`);
  return c;
  }
}

/** Reset the branch to where it was before a push. Refuses if the branch has moved on. */
export async function undo(gh, rec) {
  const base = `/repos/${rec.full}`;
  const ref = await gh.get(`${base}/git/ref/heads/${rec.branch}`);
  if (ref.object.sha !== rec.head) throw new Error('The branch has new commits since this push, so Kiln will not reset it.');
  await gh.patch(`${base}/git/refs/heads/${rec.branch}`, { sha: rec.prev, force: true });
}
