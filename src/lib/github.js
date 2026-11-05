const API = 'https://api.github.com';

export class GitHub {
  constructor(token) { this.token = token; }

  async request(method, path, body) {
    const payload = body && JSON.stringify(body);
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(API + path, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            ...(body && { 'Content-Type': 'application/json' }),
          },
          body: payload,
        });
      } catch (e) {                       // network blip: retry
        if (attempt < 5) { await new Promise((r) => setTimeout(r, 400 * 2 ** attempt)); continue; }
        throw e;
      }
      if (res.ok) return res.status === 204 ? null : res.json();
      const j = await res.json().catch(() => ({}));
      const limited = res.status === 429 || (res.status === 403 && /rate limit|abuse|secondary/i.test(j.message || ''));
      if ((limited || res.status >= 500) && attempt < 6) {
        const ra = Number(res.headers.get('retry-after'));
        await new Promise((r) => setTimeout(r, ra ? ra * 1000 : Math.min(30000, 800 * 2 ** attempt)));
        continue;
      }
      throw new Error(`GitHub ${res.status}: ${j.message || res.statusText}`);
    }
  }

  get = (p) => this.request('GET', p);
  post = (p, b) => this.request('POST', p, b);
  patch = (p, b) => this.request('PATCH', p, b);

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
