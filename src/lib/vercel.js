/** Vercel client (via our /api/vercel proxy) and the deploy orchestration. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Vercel {
  constructor(token, team = '') { this.token = token; this.team = team; }

  async request(method, path, body) {
    const q = this.team ? `${path.includes('?') ? '&' : '?'}teamId=${encodeURIComponent(this.team)}` : '';
    let res;
    try {
      res = await fetch('/api/vercel?p=' + encodeURIComponent(path + q), {
        method,
        headers: { 'x-vercel-token': this.token, ...(body && { 'Content-Type': 'application/json' }) },
        body: body && JSON.stringify(body),
      });
    } catch { throw new Error('Could not reach /api/vercel. Deploys need the Vercel proxy (use the deployed app or `vercel dev`).'); }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(j.error?.message || `Vercel ${res.status}`), { status: res.status });
    return j;
  }

  me = () => this.request('GET', '/v2/user');
  project = (name) => this.request('GET', `/v9/projects/${encodeURIComponent(name)}`).catch((e) => { if (e.status === 404) return null; throw e; });
  createProject = (b) => this.request('POST', '/v11/projects', b);
  createDeployment = (b) => this.request('POST', '/v13/deployments?forceNew=1&skipAutoDetectionConfirmation=1', b);
  deployment = (id) => this.request('GET', `/v13/deployments/${id}`);
  events = (id) => this.request('GET', `/v3/deployments/${id}/events?direction=forward&limit=-1`);
}

/** Look at package.json to preselect a framework. */
export async function guessFramework(gh, repo) {
  const f = await gh.get(`/repos/${repo.full_name}/contents/package.json`);
  const pkg = JSON.parse(atob(f.content.replace(/\n/g, '')));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const has = (k) => k in deps;
  if (has('next')) return 'nextjs';
  if (has('astro')) return 'astro';
  if (has('nuxt')) return 'nuxtjs';
  if (has('@remix-run/react')) return 'remix';
  if (has('gatsby')) return 'gatsby';
  if (has('react-scripts')) return 'create-react-app';
  if (has('vite')) return 'vite';
  return '';
}

// Vercel exposes no percentage, so progress follows real states and build-log milestones.
// It only moves forward and reaches 100 only when the deployment is READY.
const STAGE = { QUEUED: [6, 'Queued'], INITIALIZING: [12, 'Initializing'], BUILDING: [20, 'Building'] };
const MILESTONES = [
  [/cloning/i, 24, 'Cloning repo'],
  [/running "vercel build"/i, 35, 'Starting build'],
  [/installing dependencies/i, 45, 'Installing dependencies'],
  [/running "(?!vercel build)(?!install)[^"]*"/i, 62, 'Running build command'],
  [/build completed/i, 85, 'Build complete'],
  [/deploying outputs/i, 92, 'Deploying outputs'],
  [/deployment completed|creating build cache/i, 96, 'Finishing up'],
];

export async function deploy(vc, repo, cfg, onProgress) {
  let pct = 0, label = '';
  const set = (p, l) => { if (p > pct) { pct = p; if (l) label = l; } onProgress(Math.min(pct, 99), label); };

  set(2, 'Preparing project');
  let proj = await vc.project(cfg.name);
  if (!proj) {
    set(3, 'Creating project');
    const body = {
      name: cfg.name,
      framework: cfg.framework || null,
      gitRepository: { type: 'github', repo: repo.full_name },
      rootDirectory: cfg.root || null,
      buildCommand: cfg.build || null,
      installCommand: cfg.install || null,
      outputDirectory: cfg.output || null,
      environmentVariables: cfg.env.map(([key, value]) => ({ key, value, type: 'encrypted', target: ['production', 'preview', 'development'] })),
    };
    try { proj = await vc.createProject(body); }
    catch (e) {
      if (/install|connect|git/i.test(e.message)) e.message += ' (Install the Vercel GitHub app for this account at github.com/apps/vercel.)';
      throw e;
    }
  }

  set(5, 'Starting deployment');
  let d = await vc.createDeployment({
    name: cfg.name, project: proj.id, target: 'production',
    gitSource: { type: 'github', repoId: repo.id, ref: cfg.branch },
  });

  const deadline = Date.now() + 20 * 60e3;
  for (;;) {
    await sleep(2000);
    d = await vc.deployment(d.id);
    const st = STAGE[d.readyState]; if (st) set(...st);
    if (d.readyState === 'READY') { onProgress(100, 'Live'); return 'https://' + (d.alias?.[0] || d.url); }
    if (d.readyState === 'ERROR' || d.readyState === 'CANCELED') {
      throw new Error(d.errorMessage || `Deployment ${d.readyState.toLowerCase()}. Check the build logs on Vercel.`);
    }
    try {
      for (const e of await vc.events(d.id)) {
        const t = e.text || e.payload?.text || '';
        for (const [re, p, l] of MILESTONES) if (re.test(t)) set(p, l);
      }
    } catch { /* logs are a bonus; state polling still drives progress */ }
    if (Date.now() > deadline) throw new Error('Timed out waiting for Vercel.');
  }
}
