/** Two phases: plan() reads the repo and decides; execute() writes one commit. */

async function gitSha(data) {
  const head = new TextEncoder().encode(`blob ${data.length}\0`);
  const buf = new Uint8Array(head.length + data.length);
  buf.set(head); buf.set(data, head.length);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-1', buf));
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

export async function plan(gh, repo, files, mode) {
  const base = `/repos/${repo.full_name}`;
  let ref;
  for (let i = 0; i < 4; i++) {  // a just-created repo can take a moment to appear
    try { ref = await gh.get(`${base}/git/ref/heads/${repo.default_branch}`); break; }
    catch (e) {
      if (i === 3 || !repo.fresh) throw new Error('This repo has no commits yet. Add a README on GitHub first, then try again.');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  const head = ref.object.sha;
  const commit = await gh.get(`${base}/git/commits/${head}`);
  const tree = await gh.get(`${base}/git/trees/${commit.tree.sha}?recursive=1`);
  const remote = new Map(tree.tree.filter((t) => t.type === 'blob').map((t) => [t.path, t]));

  const upload = [], keep = [];
  for (const [path, data] of files) {
    const sha = await gitSha(data), r = remote.get(path);
    if (r?.sha === sha) keep.push({ path, sha, mode: r.mode });
    else upload.push({ path, data, mode: r?.mode || '100644' });
  }
  const deletions = mode === 'replace' ? [...remote.keys()].filter((p) => !files.has(p)).sort() : [];
  return { base, branch: repo.default_branch, head, treeSha: commit.tree.sha, mode, upload, keep, deletions,
           changes: upload.length + deletions.length };
}

export async function execute(gh, p, message, onProgress) {
  let done = 0;
  const added = await pool(p.upload, 6, async (f) => {
    const b = await gh.post(`${p.base}/git/blobs`, { content: toBase64(f.data), encoding: 'base64' });
    onProgress(++done, p.upload.length);
    return { path: f.path, mode: f.mode, type: 'blob', sha: b.sha };
  });
  const replace = p.mode === 'replace';
  const tree = replace ? [...added, ...p.keep.map((k) => ({ ...k, type: 'blob' }))] : added;
  const t = await gh.post(`${p.base}/git/trees`, replace ? { tree } : { base_tree: p.treeSha, tree });
  const c = await gh.post(`${p.base}/git/commits`, { message, tree: t.sha, parents: [p.head] });
  await gh.patch(`${p.base}/git/refs/heads/${p.branch}`, { sha: c.sha });
  return c;
}

/** Reset the branch to where it was before a push. Refuses if the branch has moved on. */
export async function undo(gh, rec) {
  const base = `/repos/${rec.full}`;
  const ref = await gh.get(`${base}/git/ref/heads/${rec.branch}`);
  if (ref.object.sha !== rec.head) throw new Error('The branch has new commits since this push, so Kiln will not reset it.');
  await gh.patch(`${base}/git/refs/heads/${rec.branch}`, { sha: rec.prev, force: true });
}
