import { log } from './log.js';
const API = 'https://api.github.com';
const TIMEOUT = 45000;     // a hung request is aborted and retried instead of freezing the push
export const inflight = new Map();
let seq = 0;

export class GitHub {
  constructor(token) { this.token = token; }

  async request(method, path, body) {
    const payload = body && JSON.stringify(body);
    const id = ++seq, tag = `#${id} ${method} ${path.slice(0, 70)}`;
    for (let attempt = 0; ; attempt++) {
      await this.gate();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), TIMEOUT);
      const t = performance.now();
      inflight.set(id, { tag, t, kb: payload ? Math.round(payload.length / 1024) : 0 });
      let res;
      try {
        res = await fetch(API + path, {
          method, signal: ac.signal,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            ...(body && { 'Content-Type': 'application/json' }),
          },
          body: payload,
        });
      } catch (e) {
        clearTimeout(timer); inflight.delete(id);
        const why = ac.signal.aborted ? `timeout after ${TIMEOUT / 1000}s` : e.message;
        log(`${tag} FAILED (${why}) attempt ${attempt + 1}`);
        if (attempt < 5) { await new Promise((r) => setTimeout(r, 400 * 2 ** attempt)); continue; }
        throw new Error(`Network error: ${why}`);
      }
      clearTimeout(timer); inflight.delete(id);
      const ms = Math.round(performance.now() - t);
      if (res.ok) {
        if (attempt || ms > 5000) log(`${tag} ok ${res.status} in ${ms}ms (attempt ${attempt + 1}, remaining=${res.headers.get('x-ratelimit-remaining')})`);
        return res.status === 204 ? null : res.json();
      }
      const j = await res.json().catch(() => ({}));
      const limited = res.status === 429 || (res.status === 403 && /rate limit|abuse|secondary/i.test(j.message || ''));
      log(`${tag} -> ${res.status} in ${ms}ms: ${j.message || res.statusText} | retry-after=${res.headers.get('retry-after')} remaining=${res.headers.get('x-ratelimit-remaining')} reset=${res.headers.get('x-ratelimit-reset')}`);
      if ((limited || res.status >= 500) && attempt < 6) {
        const ra = Number(res.headers.get('retry-after'));
        const wait = ra ? Math.min(ra, 120) * 1000 : Math.min(30000, 800 * 2 ** attempt);
        log(`${tag} waiting ${Math.round(wait / 1000)}s before retry ${attempt + 2}`);
        if (limited) this.until = Math.max(this.until || 0, Date.now() + wait);   // pause EVERY request, not just this one
        else await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw new Error(`GitHub ${res.status}: ${j.message || res.statusText}`);
    }
  }

  async gate() { const w = (this.until || 0) - Date.now(); if (w > 0) await new Promise((r) => setTimeout(r, w)); }

  get = (p) => this.request('GET', p);
  post = (p, b) => this.request('POST', p, b);
  patch = (p, b) => this.request('PATCH', p, b);
  del = (p) => this.request('DELETE', p);
  async graphql(query, variables) {
    const j = await this.request('POST', '/graphql', { query, variables });
    if (j.errors?.length) throw new Error(`GraphQL: ${j.errors[0].message}`);
    return j.data;
  }

  /** New repo with an initial commit, so the Git Data API can write to it. */
  createRepo = (name, isPrivate) => this.post('/user/repos', { name, private: isPrivate, auto_init: true });

  /** Repos you can push to, most recently pushed first. */
  async repos() {
    const all = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await this.get(`/user/repos?per_page=100&sort=pushed&direction=desc&page=${page}`);
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all.filter((r) => !r.archived && r.permissions?.push);
  }
}
