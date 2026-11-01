// Deploys an edge function through the Supabase Management API (needs multipart, so it gets its own route).
export default async function handler(req, res) {
  const token = req.headers['x-supabase-token'];
  const { ref, slug, files, verify_jwt = true } = req.body || {};
  if (!token) return res.status(401).json({ message: 'Missing Supabase token.' });
  if (!/^[a-z0-9]{20}$/.test(ref || '') || !/^[a-z0-9_-]+$/.test(slug || '') || !Array.isArray(files) || !files.length) {
    return res.status(400).json({ message: 'Bad request.' });
  }
  const fd = new FormData();
  fd.append('metadata', JSON.stringify({ entrypoint_path: 'index.ts', name: slug, verify_jwt }));
  for (const f of files) fd.append('file', new Blob([f.content], { type: 'application/typescript' }), f.name);
  const up = await fetch(`https://api.supabase.com/v1/projects/${ref}/functions/deploy?slug=${slug}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
  });
  res.status(up.status).send(await up.text());
}
