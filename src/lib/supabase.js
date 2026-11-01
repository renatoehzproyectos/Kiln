/** Supabase Management API client (via /api/supabase) and the "make login work" recipe. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Supabase {
  constructor(token) { this.token = token; }

  async request(method, path, body) {
    let res;
    try {
      res = await fetch('/api/supabase?p=' + encodeURIComponent(path), {
        method,
        headers: { 'x-supabase-token': this.token, ...(body && { 'Content-Type': 'application/json' }) },
        body: body && JSON.stringify(body),
      });
    } catch { throw new Error('Could not reach /api/supabase. Use the deployed app or `vercel dev`.'); }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.message || j.error || `Supabase ${res.status}`);
    return j;
  }

  orgs = () => this.request('GET', '/v1/organizations');
  projects = async () => (await this.request('GET', '/v1/projects')).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  project = (ref) => this.request('GET', `/v1/projects/${ref}`);
  createProject = (b) => this.request('POST', '/v1/projects', b);
  keys = (ref) => this.request('GET', `/v1/projects/${ref}/api-keys`);
  query = (ref, query) => this.request('POST', `/v1/projects/${ref}/database/query`, { query });
  secrets = (ref, list) => this.request('POST', `/v1/projects/${ref}/secrets`, list);
  functions = (ref) => this.request('GET', `/v1/projects/${ref}/functions`);
  async deployFunction(ref, slug, files) {
    const res = await fetch('/api/supabase-deploy', {
      method: 'POST',
      headers: { 'x-supabase-token': this.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref, slug, files, verify_jwt: true }),
    }).catch(() => { throw new Error('Could not reach /api/supabase-deploy. Use the deployed app or `vercel dev`.'); });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.message || j.error || `Supabase ${res.status}`);
    return j;
  }
  patchAuth = (ref, b) => this.request('PATCH', `/v1/projects/${ref}/config/auth`, b);
}

/** Profile row per user, created by a trigger, locked down with row-level security. */
export const PROFILES_SQL = `
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text, full_name text, avatar_url text,
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
drop policy if exists "Users read own profile" on public.profiles;
create policy "Users read own profile" on public.profiles for select using (auth.uid() = id);
drop policy if exists "Users update own profile" on public.profiles;
create policy "Users update own profile" on public.profiles for update using (auth.uid() = id);
drop policy if exists "Users insert own profile" on public.profiles;
create policy "Users insert own profile" on public.profiles for insert with check (auth.uid() = id);
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name');
  return new;
end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
`;

export const planSteps = (cfg) => [
  cfg.create && ['create', 'Create project'],
  ['ready', 'Wait for the database'],
  cfg.sqlFiles?.length && ['migrate', `Run ${cfg.sqlFiles.length} SQL file${cfg.sqlFiles.length > 1 ? 's' : ''} from the zip`],
  cfg.profiles && ['sql', 'Create profiles table, policies and trigger'],
  ['auth', 'Configure auth (site URL, redirects, email)'],
  ['keys', 'Fetch the public API key'],
  cfg.patchName && ['file', `Put the new URL and key into ${cfg.patchName}`],
  cfg.vercel && ['vercel', 'Send URL and key to Vercel'],
].filter(Boolean);

export async function setupLogin(sb, vc, cfg, step) {
  const run = async (key, fn) => {
    step(key, 'run');
    try { const r = await fn(); step(key, 'ok'); return r; }
    catch (e) { step(key, 'fail', e.message); throw e; }
  };
  let ref = cfg.ref;
  if (cfg.create) {
    ref = (await run('create', () => sb.createProject({
      name: cfg.name, organization_slug: cfg.org, db_pass: cfg.dbPass, region: cfg.region,
    }))).id;
  }
  await run('ready', async () => {
    for (let i = 0; i < 90; i++) {
      const p = await sb.project(ref);
      if (p.status === 'ACTIVE_HEALTHY') {
        for (let j = 0; j < 8; j++) { try { await sb.query(ref, 'select 1'); return; } catch { await sleep(3000); } }
        return;
      }
      if (/FAIL|REMOVED|INACTIVE|PAUSED/.test(p.status)) throw new Error(`Project status: ${p.status}`);
      await sleep(4000);
    }
    throw new Error('The project is taking long to start. Check the Supabase dashboard.');
  });
  if (cfg.sqlFiles?.length) {
    await run('migrate', async () => {
      for (const f of cfg.sqlFiles) {
        try { await sb.query(ref, f.sql); }
        catch (e) { throw new Error(`${f.name}: ${e.message}`); }
      }
    });
  }
  if (cfg.profiles) await run('sql', () => sb.query(ref, PROFILES_SQL));
  await run('auth', () => sb.patchAuth(ref, {
    site_url: cfg.siteUrl || undefined,
    uri_allow_list: cfg.redirects || undefined,
    external_email_enabled: true,
    mailer_autoconfirm: !cfg.confirmEmail,
  }));
  const anon = await run('keys', async () => {
    const k = (await sb.keys(ref)).find((x) => x.name === 'anon');
    if (!k) throw new Error('No anon key found for this project.');
    return k.api_key;     // the service_role key is never read or sent anywhere
  });
  const url = `https://${ref}.supabase.co`;
  if (cfg.patchName) await run('file', async () => cfg.patchFile(url, anon));
  let vercelOk = false;
  if (cfg.vercel) {
    try {
      await run('vercel', async () => {
        const proj = await vc.project(cfg.vercelName);
        if (!proj) throw new Error(`No Vercel project named “${cfg.vercelName}”. Deploy it once first.`);
        await vc.setEnv(proj.id, `${cfg.prefix}SUPABASE_URL`, url);
        await vc.setEnv(proj.id, `${cfg.prefix}SUPABASE_ANON_KEY`, anon);
      });
      vercelOk = true;
    } catch { /* shown in the checklist; the keys below still work */ }
  }
  return { ref, url, anon, vercelOk };
}

/* ---- Finish setup: edge functions, secrets, email (SMTP) and auth URLs ---- */
export const finishSteps = (c) => [
  c.functions.length && ['fn', `Deploy function${c.functions.length > 1 ? 's' : ''}: ${c.functions.map((f) => f.slug).join(', ')}`],
  c.resendKey && ['secrets', 'Set secrets RESEND_API_KEY, FROM_EMAIL and APP_URL'],
  c.resendKey && c.smtp && ['smtp', 'Use Resend as the project’s email (SMTP)'],
  c.siteUrl && ['urls', 'Set Site URL and Redirect URLs'],
  c.functions.length && ['verify', 'Check the functions are live'],
].filter(Boolean);

export async function finishSetup(sb, c, step) {
  const run = async (key, fn) => {
    step(key, 'run');
    try { const r = await fn(); step(key, 'ok'); return r; }
    catch (e) { step(key, 'fail', e.message); throw e; }
  };
  const app = c.siteUrl ? c.siteUrl.replace(/\/*$/, '/') : '';
  if (c.functions.length) {
    await run('fn', async () => { for (const f of c.functions) await sb.deployFunction(c.ref, f.slug, f.files); });
  }
  if (c.resendKey) {
    await run('secrets', () => sb.secrets(c.ref, [
      { name: 'RESEND_API_KEY', value: c.resendKey },
      { name: 'FROM_EMAIL', value: c.fromEmail },
      ...(app ? [{ name: 'APP_URL', value: app }] : []),
    ]));
    if (c.smtp) {
      const m = c.fromEmail.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
      await run('smtp', () => sb.patchAuth(c.ref, {
        smtp_host: 'smtp.resend.com', smtp_port: '465', smtp_user: 'resend', smtp_pass: c.resendKey,
        smtp_admin_email: m ? m[2] : c.fromEmail.trim(), smtp_sender_name: (m && m[1]) || 'OBRA360',
      }));
    }
  }
  if (c.siteUrl) {
    const origin = app.replace(/\/$/, '');
    await run('urls', () => sb.patchAuth(c.ref, {
      site_url: origin,
      uri_allow_list: [...new Set([origin, `${origin}/**`, ...c.redirects.split(',').map((x) => x.trim()).filter(Boolean)])].join(','),
    }));
  }
  if (c.functions.length) {
    await run('verify', async () => {
      const live = await sb.functions(c.ref);
      for (const f of c.functions) {
        const hit = live.find((x) => x.slug === f.slug);
        if (!hit) throw new Error(`“${f.slug}” is not listed in the project.`);
        if (hit.status && hit.status !== 'ACTIVE') throw new Error(`“${f.slug}” status: ${hit.status}`);
      }
    });
  }
}
