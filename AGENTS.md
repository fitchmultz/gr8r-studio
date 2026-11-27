# Gr8r Studio — Project Agent Guide

## Remotes & PRs

- `origin` is `fitchmultz/gr8r-studio`; `upstream` is `gr8rstudio/gr8r-studio`.
- Always target `origin` explicitly (`gh-personal pr ... -R fitchmultz/gr8r-studio`, and `--remote origin` for `gh stack`) so PRs never open against upstream.

## Architecture & Conventions

- Plain JavaScript ES modules and CSS, bundled by Vite; no UI framework, and zero runtime dependencies for the server (`server/`) and CLI (`cli/gr8r.js`).
- Dependencies point downward:
  1. `src/core/` (`constants.js`, `dates.js`, `markdown.js`, `domain.js`) and `src/data/seed.js` are shared between Node (`server/`) and the browser. Keep them DOM-free.
  2. `src/ui/`, `src/shell/`, `src/components/`, `src/pages/`, `src/views/`, `src/overlays/`, `src/features/` render HTML from the store (`S`).
  3. `src/actions/` mutate state and re-render.
- Domain mutations go through `src/core/domain.js` so the browser UI, REST API (`server/api.js`), and CLI (`cli/gr8r.js`) enforce identical invariants.
- Client sync (`src/core/sync.js`) is compile-time gated on `import.meta.env.VITE_SYNC_URL`. If `VITE_SYNC_URL` is unset at build time, the frontend compiles as a standalone localStorage-only app and never calls `/api`.

## Checks

```bash
npm run lint
npm run format:check
npm test
npm run build:server   # self-hosted build (VITE_SYNC_URL=/api)
npm run build          # static/standalone build (Vercel)
```

## Production Deployment (`m1-mbp`)

Gr8r Studio runs natively on **`m1-mbp`** (`~/Projects/gr8r-studio`) on `127.0.0.1:4180`, served privately across the personal tailnet via Tailscale Serve at `https://m1-mbp.tail854973.ts.net:8443` (`--https=8443 4180`).

### Managed Services (owned by `fitchmultz/dotfiles`)

All three services run on `m1-mbp` in the `user/$uid` launchd domain (`LimitLoadToSessionType: Background`) so they survive unattended reboots without a GUI login:

| LaunchAgent                       | Purpose                                                                                                                                                                       | Logs                               |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `com.fitchmultz.gr8r`             | Native Node sync server (`127.0.0.1:4180`, reads `~/Projects/gr8r-studio/.env`)                                                                                               | `~/Library/Logs/gr8r/`             |
| `com.fitchmultz.gr8r-backup`      | Every 5 min: snapshots `state.json` to `~/.local/state/gr8r-studio-backups/` and replicates to `alienarchy:/mnt/ssd1tb/backups/gr8r-studio/` (with `/mnt/ssd1tb` mount guard) | `~/Library/Logs/gr8r-backup/`      |
| `com.fitchmultz.gr8r-github-sync` | Every 60s: polls GitHub PRs and links `KEY-123` tasks via `/api/github/pull-requests`                                                                                         | `~/Library/Logs/gr8r-github-sync/` |

Authoritative data lives on `m1-mbp` in `~/Projects/gr8r-studio/server/data/state.json` and `~/Projects/gr8r-studio/server/data/blobs/`. Never overwrite or delete `server/data/` or `.env`.

### Deploy Steps on `m1-mbp`

**Always build with `npm run build:server` (`VITE_SYNC_URL=/api vite build`) when deploying to `m1-mbp`.** Never deploy a bare `npm run build` to the live server.

```bash
ssh m1-mbp '
  set -eu
  cd ~/Projects/gr8r-studio
  git pull --ff-only origin main
  # Run npm ci only if package-lock.json changed
  npm run build:server
  grep -q "/api/config" dist/assets/*.js
'
```

- **Frontend-only changes (`src/`, `public/`, `index.html`):** `server/server.js` reads `dist/` directly from disk, so rebuilding `dist/` takes effect immediately without restarting the server.
- **Server or shared domain changes (`server/`, `src/core/domain.js`, `src/core/markdown.js`, `src/core/dates.js`, `src/core/constants.js`):** Restart the server after pulling:
  ```bash
  ssh m1-mbp 'launchctl kickstart -k user/$(id -u)/com.fitchmultz.gr8r'
  ```
- **Verify live after deploy:**
  - `gr8r config show` and `gr8r status` return `connected` and the expected workspace revision.
  - `curl -s -o /dev/null -w '%{http_code}\n' https://m1-mbp.tail854973.ts.net:8443/` returns `200`.
  - For frontend changes, confirm `https://m1-mbp.tail854973.ts.net:8443/` renders live workspace projects (not an empty seed workspace) in a real browser.

### CLI & Skill Rollout

Changes to `cli/gr8r.js` or `skills/gr8r-studio/SKILL.md` must also be rolled out to `~/.pi/agent/git/github.com/fitchmultz/gr8r-studio` across all five devices (`mitchs-m5-mbp`, `m1-mbp`, `alienarchy`, `mitchs-workos-m5`, `fold8`) via `mitch-devices` (`pi-package-rollout`).
