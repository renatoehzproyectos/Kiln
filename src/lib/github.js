const API = 'https://api.github.com';

export class GitHub {
  constructor(token) { this.token = token; }

  async request(method, path, body) {
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body && { 'Content-Type': 'application/json' }),
      },
      body: body && JSON.stringify(body),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(`GitHub ${res.status}: ${j.message || res.statusText}`);
    }
    return res.status === 204 ? null : res.json();
  }

  get = (p) => this.request('GET', p);
  post = (p, b) => this.request('POST', p, b);
  patch = (p, b) => this.request('PATCH', p, b);

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
