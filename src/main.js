import './styles/theme.css';
import './styles/app.css';
import { GitHub } from './lib/github.js';
import { readZip, rootCandidates, filesUnder } from './lib/zip.js';
import { Supabase, setupLogin, planSteps, finishSetup, finishSteps } from './lib/supabase.js';
import { Vercel, deploy, guessFramework } from './lib/vercel.js';
import { plan, execute, undo as undoPush } from './lib/push.js';

const $ = (s) => document.querySelector(s);
const KEY = 'kiln.token', VK = 'kiln.vtoken', VT = 'kiln.vteam', SK = 'kiln.sbtoken';
const s = { gh: null, zip: null, zipName: '', repos: [], repo: null, mode: 'update', busy: false };

const curMode = () => (s.repo?.fresh ? 'replace' : s.mode);   // a brand-new repo only has our README
const UK = 'kiln.undo';
const undoStore = {
  all() { try { return JSON.parse(localStorage.getItem(UK)) || {}; } catch { return {}; } },
  get(f) { return this.all()[f]; },
  set(f, r) { const a = this.all(); a[f] = r; localStorage.setItem(UK, JSON.stringify(a)); },
  del(f) { const a = this.all(); delete a[f]; localStorage.setItem(UK, JSON.stringify(a)); },
};
const say = (msg, kind = '') => { const el = $('#status'); el.className = kind; el.innerHTML = msg; };
const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
function ago(iso) {
  const m = (new Date(iso) - Date.now()) / 60000;
  for (const [u, n] of [['minute', 60], ['hour', 24], ['day', 30], ['month', 12]]) {
    if (Math.abs(m) < n * (u === 'minute' ? 1 : u === 'hour' ? 60 : u === 'day' ? 1440 : 43200)) {
      const div = u === 'minute' ? 1 : u === 'hour' ? 60 : u === 'day' ? 1440 : 43200;
      return rtf.format(Math.round(m / div), u);
    }
  }
  return rtf.format(Math.round(m / 525600), 'year');
}

/* ---------- settings & connection ---------- */
const dlg = $('#settings');
const note = (msg, kind = '') => { const el = $('#settingsMsg'); el.textContent = msg; el.className = kind; };
function openSettings(msg = '') {
  $('#token').value = localStorage.getItem(KEY) || '';
  $('#vtoken').value = localStorage.getItem(VK) || '';
  $('#vteam').value = localStorage.getItem(VT) || '';
  $('#sbtoken').value = localStorage.getItem(SK) || '';
  note(msg); dlg.showModal(); $('#token').focus();
}
async function connect(token) {
  const gh = new GitHub(token);
  s.repos = await gh.repos();            // throws on a bad token
  s.gh = gh;
  $('#needToken').hidden = true; $('#flow').hidden = false;
  renderRepos();
}
function disconnect() {
  Object.assign(s, { gh: null, repos: [], repo: null });
  $('#flow').hidden = true; $('#needToken').hidden = false;
  renderRepos(); refresh();
}
$('#openSettings').onclick = () => openSettings();
$('#addToken').onclick = () => openSettings();
$('#token').onkeydown = (e) => e.key === 'Enter' && (e.preventDefault(), $('#saveToken').click());
$('#saveToken').onclick = async () => {
  const token = $('#token').value.trim();
  if (!token) return note('Paste a token first.', 'error');
  const btn = $('#saveToken'); btn.disabled = true; btn.textContent = 'Checking…';
  try {
    const vt = $('#vtoken').value.trim(), team = $('#vteam').value.trim();
    if (vt) {
      const vc = new Vercel(vt, team);
      try { await vc.me(); } catch (e) { throw new Error(`Vercel token: ${e.message}`); }
      s.vc = vc; localStorage.setItem(VK, vt); localStorage.setItem(VT, team);
    } else { s.vc = null; localStorage.removeItem(VK); localStorage.removeItem(VT); }
    const st = $('#sbtoken').value.trim();
    if (st) {
      const sb = new Supabase(st);
      try { await sb.orgs(); } catch (e) { throw new Error(`Supabase token: ${e.message}`); }
      s.sb = sb; localStorage.setItem(SK, st);
    } else { s.sb = null; localStorage.removeItem(SK); }
    await connect(token);
    localStorage.setItem(KEY, token);
    dlg.close(); $('#q').focus();
  } catch (e) { note(e.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = 'Save token'; }
};
$('#removeToken').onclick = () => {
  localStorage.removeItem(KEY); $('#token').value = ''; disconnect(); note('Token removed.');
};

/* ---------- zip ---------- */
async function loadZip(file) {
  if (!file) return;
  try {
    s.zip = await readZip(file); s.zipName = file.name;
    const roots = rootCandidates(s.zip);
    $('#rootSel').innerHTML = roots.map((r) => `<option value="${esc(r)}">${r ? esc(r) : '/ (top level of the zip)'}</option>`).join('');
    $('#roots').hidden = roots.length < 2;
    $('#drop').classList.add('filled');
    $('#dropTitle').textContent = file.name;
    refresh();
  } catch { say('That file could not be read as a zip.', 'error'); }
}
const drop = $('#drop');
$('#file').onchange = (e) => loadZip(e.target.files[0]);
drop.onkeydown = (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), $('#file').click());
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => loadZip(e.dataTransfer.files[0]));
$('#rootSel').onchange = refresh;

/* ---------- repos ---------- */
function renderRepos() {
  const q = $('#q').value.trim().toLowerCase();
  const list = s.repos.filter((r) => r.full_name.toLowerCase().includes(q));
  $('#repoList').innerHTML = list.length
    ? list.map((r) => `<li role="option" data-id="${r.id}" aria-selected="${s.repo?.id === r.id}">
        <span>${esc(r.full_name)} ${r.private ? '<span class="lock">private</span>' : ''}</span><small>${ago(r.pushed_at)}</small></li>`).join('')
    : '<li class="empty">No repo matches.</li>';
}
$('#q').oninput = renderRepos;
$('#q').onkeydown = (e) => {
  if (e.key !== 'Enter') return;
  const first = $('#repoList li[data-id]'); if (first) first.click();
};
$('#repoList').onclick = (e) => {
  const li = e.target.closest('li[data-id]'); if (!li) return;
  s.repo = s.repos.find((r) => r.id === +li.dataset.id);
  renderRepos(); refresh();
};
document.querySelectorAll('input[name=mode]').forEach((i) => (i.onchange = () => { s.mode = i.value; refresh(); }));

/* ---------- push ---------- */
function currentFiles() { return filesUnder(s.zip, $('#rootSel').value); }
function refresh() {
  const ready = s.zip && s.repo && !s.busy;
  const n = s.zip ? currentFiles().size : 0;
  $('#push').disabled = !ready || n === 0;
  $('#push').textContent = s.zip && s.repo
    ? s.repo.fresh ? `Push ${n} file${n === 1 ? '' : 's'} to ${s.repo.name}` : `${curMode() === 'replace' ? 'Replace' : 'Update'} ${s.repo.name} with ${n} file${n === 1 ? '' : 's'}`
    : 'Push';
  $('#deploy').disabled = !s.repo || s.busy;
  renderUndo();
  if (s.zip && n === 0) say('No files under that root.', 'error');
}

const confirmDeletes = (list) => new Promise((resolve) => {
  const dlg = $('#confirm');
  $('#delList').innerHTML = list.map((p) => `<li>${esc(p)}</li>`).join('');
  dlg.onclose = () => resolve(dlg.returnValue === 'push');
  dlg.showModal();
});

$('#push').onclick = async () => {
  s.busy = true; refresh(); say('Reading repo…');
  try {
    const p = await plan(s.gh, s.repo, currentFiles(), curMode());
    if (!p.changes) return say('Already up to date. Nothing to push.', 'ok');
    if (p.deletions.length && !s.repo.fresh && !(await confirmDeletes(p.deletions))) return say('Cancelled. Nothing was changed.');
    const c = await execute(s.gh, p, `Sync from ${s.zipName}`, (d, t) => say(`Uploading ${d} of ${t}…`));
    undoStore.set(s.repo.full_name, { full: s.repo.full_name, branch: p.branch, prev: p.head, head: c.sha, at: Date.now() });
    s.repo.fresh = false;
    say(`Pushed to ${esc(s.repo.default_branch)}. <a target="_blank" rel="noopener" href="${c.html_url}">View commit</a>`, 'ok');
    s.repo.pushed_at = new Date().toISOString();
    s.repos.sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at));
    renderRepos();
  } catch (e) { say(esc(e.message), 'error'); }
  finally { s.busy = false; refresh(); }
};

/* ---------- new repo ---------- */
const nrd = $('#newRepoDlg');
const slug = (n) => n.replace(/\.zip$/i, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
const nrNote = (t) => { $('#newRepoMsg').textContent = t; };
$('#newRepo').onclick = () => {
  $('#repoName').value = s.zipName ? slug(s.zipName) : '';
  $('#createRepo').textContent = s.zip ? 'Create & push' : 'Create repo';
  nrNote(''); nrd.showModal(); $('#repoName').select();
};
$('#repoName').onkeydown = (e) => e.key === 'Enter' && (e.preventDefault(), $('#createRepo').click());
$('#createRepo').onclick = async () => {
  const name = $('#repoName').value.trim();
  if (!name) return nrNote('Give the repo a name.');
  const btn = $('#createRepo'), label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    const isPrivate = document.querySelector('input[name=vis]:checked').value === 'private';
    const r = await s.gh.createRepo(name, isPrivate);
    r.fresh = true;
    s.repos.unshift(r); s.repo = r; $('#q').value = '';
    renderRepos(); refresh(); nrd.close();
    if (s.zip) $('#push').click();
  } catch (e) { nrNote(e.message); }
  finally { btn.disabled = false; btn.textContent = label; }
};

/* ---------- undo ---------- */
function renderUndo() {
  const b = $('#undo'), rec = s.repo && undoStore.get(s.repo.full_name);
  delete b.dataset.armed;
  b.hidden = !rec;
  if (rec) b.textContent = `Undo last push to ${s.repo.name} (${ago(new Date(rec.at).toISOString())})`;
}
$('#undo').onclick = async () => {
  const b = $('#undo'), rec = undoStore.get(s.repo.full_name);
  if (!rec) return;
  if (!b.dataset.armed) {            // two clicks: arm, then confirm
    b.dataset.armed = '1'; b.textContent = 'Click again to reset the branch';
    setTimeout(() => b.dataset.armed && renderUndo(), 4000);
    return;
  }
  b.disabled = true; say('Undoing…');
  try {
    await undoPush(s.gh, rec);
    undoStore.del(rec.full);
    say(`Undone. ${esc(rec.branch)} is back at ${rec.prev.slice(0, 7)}.`, 'ok');
  } catch (e) { say(esc(e.message), 'error'); }
  finally { b.disabled = false; renderUndo(); }
};

/* ---------- deploy to Vercel ---------- */
const dd = $('#deployDlg');
let deploying = false;
dd.addEventListener('cancel', (e) => deploying && e.preventDefault());
$('#deploy').onclick = () => {
  if (!s.vc) return openSettings('Add a Vercel token to deploy.');
  const r = s.repo;
  $('#deployForm').hidden = false; $('#deployRun').hidden = true; $('#dMsg').textContent = '';
  $('#dRepo').textContent = r.full_name;
  $('#dName').value = r.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/-{3,}/g, '--').slice(0, 100);
  $('#dBranch').value = r.default_branch;
  for (const id of ['dRoot', 'dInstall', 'dBuild', 'dOutput', 'dEnv']) $('#' + id).value = '';
  $('#dFramework').value = '';
  dd.showModal();
  guessFramework(s.gh, r).then((f) => { if (f && !deploying) $('#dFramework').value = f; }).catch(() => {});
};
$('#dGo').onclick = async () => {
  const v = (id) => $('#' + id).value.trim();
  if (!v('dName')) return ($('#dMsg').textContent = 'Give the project a name.');
  const env = v('dEnv').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1)] : null; });
  if (env.includes(null)) return ($('#dMsg').textContent = 'Environment variables must look like KEY=value.');
  const cfg = { name: v('dName'), framework: v('dFramework'), branch: v('dBranch') || s.repo.default_branch,
    root: v('dRoot').replace(/^\.\/?$/, ''), install: v('dInstall'), build: v('dBuild'), output: v('dOutput'), env };

  $('#deployForm').hidden = true; $('#deployRun').hidden = false; $('#runActions').hidden = true;
  $('#runTitle').textContent = 'Deploying…'; $('#runMsg').textContent = '';
  const show = (p, label) => { $('#pct').textContent = `${p}%`; $('#barFill').style.width = `${p}%`; $('#runStage').textContent = label; };
  show(0, 'Starting…'); deploying = true;
  try {
    const url = await deploy(s.vc, s.repo, cfg, show);
    $('#runTitle').textContent = 'Deployed'; $('#runOk').textContent = 'OK';
    localStorage.setItem('kiln.lasturl', url);
    $('#goApp').hidden = false; $('#goApp').onclick = () => location.assign(url);
  } catch (e) {
    $('#runTitle').textContent = 'Deployment failed'; $('#runMsg').textContent = e.message;
    $('#runOk').textContent = 'Close'; $('#goApp').hidden = true;
  } finally { deploying = false; $('#runActions').hidden = false; }
};

/* ---------- Supabase login setup ---------- */
const sd = $('#sbDlg');
let sbRunning = false;
sd.addEventListener('cancel', (e) => sbRunning && e.preventDefault());
const randPass = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18)))).replace(/[+/=]/g, 'x');
const PREFIX = { nextjs: 'NEXT_PUBLIC_', 'create-react-app': 'REACT_APP_', astro: 'PUBLIC_' };
const toggleNew = () => { $('#sNew').hidden = !!$('#sProject').value; };
$('#sProject').onchange = toggleNew;

$('#sbOpen').onclick = async () => {
  if (!s.sb) return openSettings('Add a Supabase token to set up login.');
  $('#sbForm').hidden = false; $('#sbRun').hidden = true; $('#sMsg').textContent = '';
  $('#sName').value = s.zipName ? slug(s.zipName) : (s.repo?.name || '');
  $('#sPass').value = randPass();
  const zname = s.zipName ? slug(s.zipName) : '';
  $('#sVercelName').value = (s.repo?.name || zname).toLowerCase();
  if (zname && !$('#sSite').value) $('#sSite').value = `https://${zname}.vercel.app`;
  const root = s.zip ? $('#rootSel').value : '';
  const sqls = s.zip ? [...s.zip.keys()].filter((p) => p.startsWith(root + 'supabase/migrations/') && p.endsWith('.sql')).sort() : [];
  const hasCfg = !!s.zip?.has(root + 'config.js');
  $('#sMigrateRow').hidden = !sqls.length;
  $('#sMigrateText').textContent = `Run ${sqls.length} SQL migration${sqls.length > 1 ? 's' : ''} from the zip (${sqls.map((p) => p.split('/').pop()).join(', ')})`;
  $('#sPatchRow').hidden = !hasCfg;
  if (sqls.length) $('#sProfiles').checked = false;   // the zip's own migration creates its profiles table
  if (hasCfg) $('#sVercel').checked = false;           // a static site reads its keys from config.js
  $('#sVercel').disabled = !s.vc; $('#sVercel').checked = !!s.vc;
  sd.showModal();
  try {
    const [orgs, projects] = await Promise.all([s.sb.orgs(), s.sb.projects()]);
    $('#sOrg').innerHTML = orgs.map((o) => `<option value="${esc(o.slug || o.id)}">${esc(o.name)}</option>`).join('');
    $('#sProject').innerHTML = '<option value="">＋ Create a new project</option>' +
      projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.region)})</option>`).join('');
    toggleNew();
  } catch (e) { $('#sMsg').textContent = e.message; }
  if (s.repo) guessFramework(s.gh, s.repo).then((f) => { $('#sPrefix').value = PREFIX[f] || 'VITE_'; }).catch(() => {});
};

$('#sGo').onclick = async () => {
  const v = (id) => $('#' + id).value.trim(), msg = (t) => { $('#sMsg').textContent = t; };
  const cfg = { create: !v('sProject'), ref: v('sProject'), name: v('sName'), org: v('sOrg'), region: v('sRegion'),
    dbPass: v('sPass'), siteUrl: v('sSite'), redirects: v('sRedirects'), confirmEmail: $('#sConfirm').checked,
    profiles: $('#sProfiles').checked, vercel: $('#sVercel').checked && !!s.vc, vercelName: v('sVercelName'), prefix: v('sPrefix') };
  const root = s.zip ? $('#rootSel').value : '';
  const sqlPaths = s.zip && $('#sMigrate').checked && !$('#sMigrateRow').hidden
    ? [...s.zip.keys()].filter((p) => p.startsWith(root + 'supabase/migrations/') && p.endsWith('.sql')).sort() : [];
  cfg.sqlFiles = sqlPaths.map((p) => ({ name: p.split('/').pop(), sql: new TextDecoder().decode(s.zip.get(p)) }));
  if ($('#sPatch').checked && !$('#sPatchRow').hidden) {
    cfg.patchName = 'config.js';
    cfg.patchFile = (url, anon) => {
      const text = new TextDecoder().decode(s.zip.get(root + 'config.js'))
        .replace(/https:\/\/[a-z0-9]{20}\.supabase\.co/g, url).replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, anon);
      s.zip.set(root + 'config.js', new TextEncoder().encode(text));
      refresh();
    };
  }
  if (cfg.create && (!cfg.name || !cfg.org)) return msg('Give the project a name and pick an organization.');
  if (cfg.vercel && !cfg.vercelName) return msg('Enter the Vercel project name, or untick that option.');

  $('#sbForm').hidden = true; $('#sbRun').hidden = false; $('#sResult').hidden = true; $('#sRunActions').hidden = true;
  $('#sRunMsg').textContent = ''; $('#sRunTitle').textContent = 'Setting up…';
  $('#sSteps').innerHTML = planSteps(cfg).map(([k, l]) => `<li data-k="${k}"><i>○</i><span>${l}</span><small></small></li>`).join('');
  const mark = { run: '…', ok: '✓', fail: '✗' };
  const step = (k, state, detail = '') => {
    const li = document.querySelector(`#sSteps li[data-k=${k}]`);
    li.className = state; li.querySelector('i').textContent = mark[state]; li.querySelector('small').textContent = detail;
  };
  sbRunning = true;
  try {
    const r = await setupLogin(s.sb, s.vc, cfg, step);
    localStorage.setItem('kiln.sbref', r.ref);
    const P = cfg.prefix;
    $('#sOut').textContent = `${P}SUPABASE_URL=${r.url}\n${P}SUPABASE_ANON_KEY=${r.anon}` +
      (cfg.create ? `\n# Database password: ${cfg.dbPass}` : '') +
      `\n\n// npm i @supabase/supabase-js\nimport { createClient } from '@supabase/supabase-js'\nconst supabase = createClient(URL, ANON_KEY)\nawait supabase.auth.signUp({ email, password })\nawait supabase.auth.signInWithPassword({ email, password })\nawait supabase.auth.signOut()`;
    $('#sResult').hidden = false; $('#sRunTitle').textContent = 'Login is ready';
    if (cfg.vercel && r.vercelOk) $('#sRunMsg').textContent = 'Keys are in Vercel. Deploy again to use them.';
    if (cfg.patchName) $('#sRunMsg').textContent = 'config.js is updated in the zip. Now create the repo or push.';
  } catch (e) { $('#sRunTitle').textContent = 'Setup stopped'; $('#sRunMsg').textContent = e.message; }
  finally { sbRunning = false; $('#sRunActions').hidden = false; }
};
$('#sCopy').onclick = async () => { await navigator.clipboard.writeText($('#sOut').textContent); $('#sCopy').textContent = 'Copied'; setTimeout(() => ($('#sCopy').textContent = 'Copy'), 1500); };

/* ---------- Finish setup (functions, secrets, SMTP, URLs) ---------- */
const fd = $('#fnDlg');
let fnRunning = false;
fd.addEventListener('cancel', (e) => fnRunning && e.preventDefault());
const zipFunctions = () => {
  if (!s.zip) return [];
  const root = $('#rootSel').value, base = root + 'supabase/functions/', by = {};
  for (const [p, d] of s.zip) {
    if (!p.startsWith(base)) continue;
    const [slug, ...rest] = p.slice(base.length).split('/');
    if (!rest.length || slug.startsWith('_')) continue;
    (by[slug] ||= []).push({ name: rest.join('/'), content: new TextDecoder().decode(d) });
  }
  return Object.entries(by).filter(([, f]) => f.some((x) => x.name === 'index.ts')).map(([slug, files]) => ({ slug, files }));
};
$('#fnOpen').onclick = async () => {
  if (!s.sb) return openSettings('Add a Supabase token first.');
  $('#fnForm').hidden = false; $('#fnRun').hidden = true; $('#fMsg').textContent = '';
  const fns = zipFunctions();
  $('#fFnRow').hidden = !fns.length;
  $('#fFnText').textContent = `Deploy ${fns.length} function${fns.length > 1 ? 's' : ''} from the zip (${fns.map((f) => f.slug).join(', ')})`;
  if (!$('#fSite').value) $('#fSite').value = localStorage.getItem('kiln.lasturl') || '';
  fd.showModal();
  try {
    const projects = await s.sb.projects(), last = localStorage.getItem('kiln.sbref');
    $('#fProject').innerHTML = projects.map((p) => `<option value="${esc(p.id)}"${p.id === last ? ' selected' : ''}>${esc(p.name)} (${esc(p.region)})</option>`).join('');
  } catch (e) { $('#fMsg').textContent = e.message; }
};
$('#fGo').onclick = async () => {
  const v = (id) => $('#' + id).value.trim(), msg = (t) => { $('#fMsg').textContent = t; };
  const functions = !$('#fFnRow').hidden && $('#fFn').checked ? zipFunctions() : [];
  const c = { ref: v('fProject'), siteUrl: v('fSite'), redirects: v('fRedirects'), functions,
    resendKey: v('fKey'), fromEmail: v('fFrom'), smtp: $('#fSmtp').checked };
  if (!c.ref) return msg('Pick a project.');
  if (c.siteUrl && !/^https?:\/\//.test(c.siteUrl)) return msg('The app URL must start with https://');
  if (c.resendKey && (!c.fromEmail || c.fromEmail.includes('yourdomain.com'))) return msg('Write your real From address (a domain you verified in Resend).');
  if (c.resendKey && !c.siteUrl) return msg('APP_URL is needed for invitation links: enter your app’s URL.');
  const steps = finishSteps(c);
  if (!steps.length) return msg('Nothing to do: fill in at least one section.');

  $('#fnForm').hidden = true; $('#fnRun').hidden = false; $('#fRunActions').hidden = true;
  $('#fRunMsg').textContent = ''; $('#fRunTitle').textContent = 'Working…';
  $('#fSteps').innerHTML = steps.map(([k, l]) => `<li data-k="${k}"><i>○</i><span>${esc(l)}</span><small></small></li>`).join('');
  const mark = { run: '…', ok: '✓', fail: '✗' };
  const step = (k, state, detail = '') => {
    const li = document.querySelector(`#fSteps li[data-k=${k}]`);
    li.className = state; li.querySelector('i').textContent = mark[state]; li.querySelector('small').textContent = detail;
  };
  fnRunning = true;
  try {
    await finishSetup(s.sb, c, step);
    localStorage.setItem('kiln.sbref', c.ref);
    $('#fRunTitle').textContent = 'All set';
    $('#fRunMsg').textContent = 'Open the app’s Consola button and sign in to re-check everything.';
  } catch (e) { $('#fRunTitle').textContent = 'Stopped'; $('#fRunMsg').textContent = e.message; }
  finally { fnRunning = false; $('#fRunActions').hidden = false; }
};

/* ---------- boot ---------- */
{ const st = localStorage.getItem(SK); if (st) s.sb = new Supabase(st); }
{ const vt = localStorage.getItem(VK); if (vt) s.vc = new Vercel(vt, localStorage.getItem(VT) || ''); }
const saved = localStorage.getItem(KEY);
if (saved) connect(saved).catch((e) => { disconnect(); openSettings(`Saved token failed: ${e.message}`); });
else { $('#needToken').hidden = false; openSettings(); }
