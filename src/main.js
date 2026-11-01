import './styles/theme.css';
import './styles/app.css';
import { GitHub } from './lib/github.js';
import { readZip, rootCandidates, filesUnder } from './lib/zip.js';
import { plan, execute } from './lib/push.js';

const $ = (s) => document.querySelector(s);
const KEY = 'kiln.token';
const s = { gh: null, zip: null, zipName: '', repos: [], repo: null, mode: 'update', busy: false };

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
    ? `${s.mode === 'replace' ? 'Replace' : 'Update'} ${s.repo.name} with ${n} file${n === 1 ? '' : 's'}`
    : 'Push';
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
    const p = await plan(s.gh, s.repo, currentFiles(), s.mode);
    if (!p.changes) return say('Already up to date. Nothing to push.', 'ok');
    if (p.deletions.length && !(await confirmDeletes(p.deletions))) return say('Cancelled. Nothing was changed.');
    const c = await execute(s.gh, p, `Sync from ${s.zipName}`, (d, t) => say(`Uploading ${d} of ${t}…`));
    say(`Pushed to ${esc(s.repo.default_branch)}. <a target="_blank" rel="noopener" href="${c.html_url}">View commit</a>`, 'ok');
    s.repo.pushed_at = new Date().toISOString();
    s.repos.sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at));
    renderRepos();
  } catch (e) { say(esc(e.message), 'error'); }
  finally { s.busy = false; refresh(); }
};

/* ---------- boot ---------- */
const saved = localStorage.getItem(KEY);
if (saved) connect(saved).catch((e) => { disconnect(); openSettings(`Saved token failed: ${e.message}`); });
else { $('#needToken').hidden = false; openSettings(); }
