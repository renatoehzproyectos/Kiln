# Kiln

Fire a zip into a GitHub repo. Pick a zip, pick a repo, push.

Open **Settings** to add, change or remove your GitHub token (saved in localStorage).

Runs entirely in the browser: the zip is unpacked locally and committed through
GitHub's Git Data API as a single commit. Your token never touches a server.

## Flow
1. Drop a `.zip` (the root folder is auto-detected; change it if needed).
2. Pick a repo (sorted by latest push; type to filter, Enter picks the first).
3. Choose **Update** (add/overwrite) or **Replace** (mirror the zip, with a delete confirmation).
4. Push.

Unchanged files are detected by git blob hash and skipped.

## Develop
```bash
npm install
npm run dev
```

## Deploy
Import the repo on Vercel. Vite is auto-detected, no env vars needed.

## Token
Create a fine-grained token at github.com/settings/personal-access-tokens/new
with **Contents: read and write** on the repos you want (or a classic token with `repo`).

## Layout
```
index.html          markup
src/main.js         UI wiring
src/lib/github.js   API client + repo list
src/lib/zip.js      unzip, root detection
src/lib/push.js     plan (diff) and execute (blobs, tree, commit, ref)
src/styles/         theme tokens, app styles
```

Limits: empty repos (no commits) aren't supported; files over ~100 MB are rejected by GitHub.
