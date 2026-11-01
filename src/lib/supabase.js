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
