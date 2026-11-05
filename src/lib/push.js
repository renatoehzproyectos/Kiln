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

const BIG = 1_000_000;          // files over this (or non-default mode) get their own blob request
const BIG_CONCURRENCY = 6;      // big bodies are bandwidth-bound; more parallelism just adds 403s
const CHAIN_BYTES = 6_000_000;  // base64 bytes per GraphQL commit
const INLINE_CHUNK = 3_000_000; // fallback path: inline text per tree request
const CONCURRENCY = 16;         // fallback path: small blobs in parallel

const GQL = `mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid tree { oid } } } }`;

export async function execute(gh, p, message, onProgress) {
  const total = p.upload.length;
  let done = 0;
  const tick = (n = 1) => { done += n; onProgress(Math.min(Math.max(done, 0), total), total); };
  const t0 = performance.now();
  const watchdog = setInterval(() => {
    const now = performance.now(), open = [...inflight.values()].sort((a, b) => a.t - b.t);
    log(`watchdog: ${done}/${total} done, ${open.length} in flight` +
      (open.length ? `, oldest ${Math.round((now - open[0].t) / 1000)}s: ${open[0].tag} (${open[0].kb}KB)` : ''));
  }, 5000);
  try { return await run(); } finally { clearInterval(watchdog); log(`execute finished after ${Math.round(performance.now() - t0)}ms`); }

  async function run() {
    const isBig = (f) => f.data.length > BIG || f.mode !== '100644';
    const big = p.upload.filter(isBig).sort((a, b) => b.data.length - a.data.length);   // biggest first
    const small = p.upload.filter((f) => !isBig(f));
    log(`execute: ${big.length} big files (${Math.round(big.reduce((s, f) => s + f.data.length, 0) / 1e6)}MB) via blobs, ${small.length} small files via batched commits`);

    const entries = [];   // tree entries that point at blobs
    const groups = new Map();
    for (const f of big) { if (groups.has(f.sha)) groups.get(f.sha).push(f); else groups.set(f.sha, [f]); }

    const bigDone = pool([...groups.values()], BIG_CONCURRENCY, async (fs) => {
      const b = await gh.post(`${p.base}/git/blobs`, { content: await toBase64(fs[0].data), encoding: 'base64' });
      for (const x of fs) entries.push({ path: x.path, mode: x.mode, type: 'blob', sha: b.sha });
      tick(fs.length);
    });

    const smallDone = commitSmall(small, entries);
    const [baseTree] = await Promise.all([smallDone, bigDone]);

    const last = [...entries, ...p.deletions.map((path) => ({ path, mode: '100644', type: 'blob', sha: null }))];
    const treeSha = last.length ? (await gh.post(`${p.base}/git/trees`, { base_tree: baseTree, tree: last })).sha : baseTree;
    const c = await gh.post(`${p.base}/git/commits`, { message, tree: treeSha, parents: [p.head] });
    await gh.patch(`${p.base}/git/refs/heads/${p.branch}`, { sha: c.sha });
    log(`commit ${c.sha.slice(0, 7)} pushed`);
    return c;
  }

  /** Small files: a few GraphQL commits on a throwaway branch (1 request per ~4 MB), then we keep only their tree. */
  async function commitSmall(small, entries) {
    if (!small.length) return p.treeSha;
    try { return await viaGraphQL(small); }
    catch (e) {
      log(`graphql path failed (${e.message}); falling back to REST for ${small.length} files`);
      return viaRest(small, entries);
    }
  }

  async function viaGraphQL(small) {
    const repo = p.base.slice('/repos/'.length);
    const tmp = `kiln-tmp-${Date.now().toString(36)}`;
    await gh.post(`${p.base}/git/refs`, { ref: `refs/heads/${tmp}`, sha: p.head });
    let oid = p.head, tree = p.treeSha, n = 0;
    try {
      const batches = []; let cur = [], size = 0;
      for (const f of small) {
        const sz = Math.ceil(f.data.length * 4 / 3) + f.path.length + 64;
        if (size + sz > CHAIN_BYTES && cur.length) { batches.push(cur); cur = []; size = 0; }
        cur.push(f); size += sz;
      }
      if (cur.length) batches.push(cur);
      // encode every batch up front (native, off-thread) while earlier commits are in flight
      const encoded = batches.map((b) => Promise.all(b.map(async (f) => ({ path: f.path, contents: await toBase64(f.data) }))));
      log(`graphql: ${batches.length} commit(s) for ${small.length} files`);
      for (let i = 0; i < batches.length; i++) {
        const additions = await encoded[i];
        const r = await gh.graphql(GQL, { input: {
          branch: { repositoryNameWithOwner: repo, branchName: tmp },
          message: { headline: message }, expectedHeadOid: oid, fileChanges: { additions },
        } });
        const c = r.createCommitOnBranch.commit;
        oid = c.oid; tree = c.tree.oid; n += batches[i].length; tick(batches[i].length);
        log(`graphql commit ${i + 1}/${batches.length} ok (${batches[i].length} files)`);
      }
      return tree;
    } catch (e) { done -= n; throw e; }
    finally { try { await gh.del(`${p.base}/git/refs/heads/${tmp}`); } catch (e) { log(`temp branch cleanup failed: ${e.message}`); } }
  }

  /** Previous approach, kept as a fallback: inline text in trees + one blob per binary. */
  async function viaRest(small, entries) {
    const inline = [], binary = [], seen = new Map();
    for (const f of small) {
      const text = asText(f.data);
      if (text !== null) inline.push({ path: f.path, mode: f.mode, type: 'blob', content: text, size: f.data.length });
      else if (seen.has(f.sha)) seen.get(f.sha).paths.push(f);
      else { const g = { f, paths: [f] }; seen.set(f.sha, g); binary.push(g); }
    }
    const blobsDone = pool(binary, CONCURRENCY, async ({ f, paths }) => {
      const b = await gh.post(`${p.base}/git/blobs`, { content: await toBase64(f.data), encoding: 'base64' });
      for (const x of paths) entries.push({ path: x.path, mode: x.mode, type: 'blob', sha: b.sha });
      tick(paths.length);
    });
    const textDone = (async () => {
      let tree = p.treeSha, cur = [], size = 0;
      const chunks = [];
      for (const e of inline) {
        if (size + e.size > INLINE_CHUNK && cur.length) { chunks.push(cur); cur = []; size = 0; }
        cur.push(e); size += e.size;
      }
      if (cur.length) chunks.push(cur);
      for (const c of chunks) {
        tree = (await gh.post(`${p.base}/git/trees`, { base_tree: tree, tree: c.map(({ size: _s, ...e }) => e) })).sha;
        tick(c.length);
      }
      return tree;
    })();
    const [tree] = await Promise.all([textDone, blobsDone]);
    return tree;
  }
}

/** Reset the branch to where it was before a push. Refuses if the branch has moved on. */
export async function undo(gh, rec) {
  const base = `/repos/${rec.full}`;
  const ref = await gh.get(`${base}/git/ref/heads/${rec.branch}`);
  if (ref.object.sha !== rec.head) throw new Error('The branch has new commits since this push, so Kiln will not reset it.');
  await gh.patch(`${base}/git/refs/heads/${rec.branch}`, { sha: rec.prev, force: true });
}
