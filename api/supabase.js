// Thin proxy to the Supabase Management API (it does not allow direct browser calls).
// The token travels in the x-supabase-token header and is never stored or logged.
export default async function handler(req, res) {
  const token = req.headers['x-supabase-token'];
  const p = String(req.query.p || '');
  if (!token) return res.status(401).json({ message: 'Missing Supabase token.' });
  if (!/^\/v1\/[A-Za-z0-9/_.\-?=&%,]*$/.test(p) || p.includes('..')) return res.status(400).json({ message: 'Bad path.' });
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const upstream = await fetch('https://api.supabase.com' + p, {
    method: req.method,
    headers: { Authorization: `Bearer ${token}`, ...(hasBody && { 'Content-Type': 'application/json' }) },
    body: hasBody ? JSON.stringify(req.body) : undefined,
  });
  res.status(upstream.status).send(await upstream.text());
}
