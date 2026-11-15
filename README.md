# Gr8r Studio

A calm, structured project management workspace: home dashboard, inbox, my tasks, projects with
board / list / table / calendar / timeline / files views, members, teams, activity and settings.

Built with plain JavaScript ES modules and CSS, bundled by [Vite](https://vite.dev). There is no
UI framework and no runtime dependency.

![Gr8r Studio home dashboard](docs/preview.png)

## Getting started

Requires Node.js 24.5+ (`.nvmrc` pins 26 Active LTS).

```bash
npm install
npm run dev       # http://localhost:5173 with hot reload
npm run build     # production build in dist/
npm run preview   # serve the production build locally
npm run lint      # ESLint
npm run format    # Prettier
```

## Project structure

```
index.html              HTML entry; loads src/main.js
public/favicon.svg      brand mark
vite.config.js          Vite config, including the Lucide icon-subset plugin
eslint.config.js        lint rules (ESLint flat config); formatting by Prettier (.prettierrc.json)
.github/workflows/      CI: lint, format check, build
docs/preview.png        README screenshot
src/
  main.js               entry: imports styles and modules, then boots the app
  styles/
    index.css           imports every stylesheet in cascade order
    tokens.css          colours, spacing, type, radius, the shared --gutter
    base.css  components.css  shell.css  panels.css  overlays.css  states.css  motion.css  responsive.css
    views/              list, board, table, calendar, timeline, projects & files
    pages/              settings, projects, members, and more
  core/                 utilities, constants, icons, store (state + lookups), theme, optional sync
  data/seed.js          starter workspace data
  ui/                   shared render helpers, toasts, the select dropdown
  shell/                render loop and router, sidebar/topbar layout, skeletons, view engine
  components/           task list renderer
  pages/                one module per route
  views/                project views: board, table, calendar, timeline, files, overview
  overlays/             task drawer, modals, popovers, context menu, command palette
  features/             teams, subtasks, archive (rendering)
  actions/              user actions, event wiring, keyboard shortcuts, drag and drop
server/
  server.js             optional self-hosted sync server: serves dist/ and the sync API
  test/                 server protocol tests (node --test)
```

### Layers

Dependencies point downward:

1. `core/` and `data/` provide shared utilities and state. `core/sync.js` also
   uses the render loop and toasts when it loads server state or reports a conflict.
2. `ui/`, `shell/`, `components/`, `pages/`, `views/`, `overlays/` and `features/` render HTML from state.
3. `actions/` change state and re-render. Each action module registers its handlers on the
   shared action table (`A`) when it loads, so `main.js` imports them after `actions/actions.js`.

## Conventions

- **Rendering:** each page or view is a function that returns an HTML string from the store
  (`S`). `render()` rebuilds the shell and keeps focus and scroll positions.
- **Interactions:** elements declare `data-a="actionName"`. `actions/events.js` delegates the
  click to `A.actionName`. Inputs use `data-in`, blur handlers use `data-blur`.
- **Layout:** every page edge uses `var(--gutter)`, so the breadcrumb, page header, toolbar,
  list, table and board start on the same line.
- **Dropdowns:** write a normal `<select class="select">`. `ui/select.js` renders it as the
  design-system menu and keeps the native element as the source of truth.
- **Icons:** call `ic('name')` with any [Lucide](https://lucide.dev) icon name. The
  `virtual:icons` plugin bundles only the icons the source uses.

## Continuous integration

Every push and pull request runs lint, the format check, a production build and the
server tests (`.github/workflows/ci.yml`).

## Deploy

`vercel.json` builds with Vite and serves `dist/` — a static deploy works, but each
browser keeps its own standalone copy (no sync).

## Self-hosting with sync

Run the bundled server to keep one workspace in sync across devices:

Keep the server behind a private network or an authenticated reverse proxy. By
default (`GR8R_TRUST_BOOTSTRAP=tailnet`), `GET /api/config` bootstraps
`GR8R_TOKEN` only for direct loopback clients and Tailscale Serve requests
carrying `Tailscale-User-Login`. Requests arriving through Tailscale Funnel,
Cloudflare Tunnel, or forwarding reverse proxies receive
`{ token: null, authRequired: true }` and must authenticate explicitly with
`GR8R_TOKEN` (`POST /api/auth` in the browser or `Authorization: Bearer` in API
clients). If you place a non-Tailscale reverse proxy on loopback (especially one
such as default nginx that omits `X-Forwarded-*` headers and rewrites `Host` to
`127.0.0.1`), set `GR8R_TRUST_BOOTSTRAP=none` so every caller must supply
`GR8R_TOKEN`.

```bash
VITE_SYNC_URL=/api npm run build
cd server && GR8R_TOKEN=<secret> npm start    # app + sync API on 127.0.0.1:4180
```

- `GR8R_TOKEN` is the single shared bearer token. Clients on private loopback or
  Tailscale Serve routes fetch it from `GET /api/config` at startup, so rotating
  it on a tailnet deployment only needs a server restart.
  `GR8R_TRUST_BOOTSTRAP` (`tailnet`, `none`, or `always`), `PORT`, `HOST`, `GR8R_DATA`
  (state file) and `DIST` (static dir) can be overridden through the environment.
- The server keeps the workspace blob and a revision in `server/data/state.json`.
  A push advances the revision only after the state file is written. An unreadable
  or invalid existing state file stops startup instead of starting an empty workspace.
  `POST /api/sync` seeds the initial workspace at revision `0`; once synced,
  browsers send field-level workspace deltas to `PATCH /api/workspace` against
  their last synced snapshot.
- Clients save locally on each change and debounce uploads. Pending uploads
  survive reloads and retry at boot, every 30 seconds, and on reconnection.
  Open tabs also subscribe to `GET /api/events` (SSE) so server-side updates
  from another device or API client appear immediately instead of waiting for
  the 30-second fallback poll.
  A response for an older upload cannot overwrite a newer local save.
- When a browser and another device or CLI agent edit concurrently (or reconnect
  after offline edits), `PATCH /api/workspace` merges project, task, subtask,
  comment, reaction, activity, and preference changes atomically on the server
  (reassigning colliding task or project keys automatically) instead of
  discarding either device's edits.
- Domain API routes (`/api/workspace`, `/api/projects`, `/api/tasks`,
  `/api/search`, `/api/activity`) apply single-entity mutations atomically on
  the server using the same domain invariants as the browser UI, advancing the
  workspace revision and notifying connected SSE clients.
- GitHub PR auto-linking (`POST /api/github/pull-requests` with `GR8R_TOKEN` or
  `POST /api/webhooks/github` signed with `GR8R_GITHUB_WEBHOOK_SECRET`) links
  PRs referencing `KEY-123` in their title, branch, or `Closes`/`Refs` clauses
  and transitions task status (`progress` on draft, `review` when ready, `done`
  when merged).

### Docker

```bash
GR8R_TOKEN=<secret> docker compose up --build -d    # app + sync API on :4180
```

The client fetches its sync token from `/api/config` at startup, so changing
`GR8R_TOKEN` just takes another `docker compose up -d` — no rebuild. Workspace
state lives in the `gr8r-data` volume (mounted at
`/app/server/data`); override paths with `GR8R_DATA` / `DIST` to mount your own.

### Open the app through Tailscale

The Compose file publishes port 4180 on loopback only. Use
[Tailscale Serve](https://tailscale.com/docs/solutions/host-private-server-docker)
on the host to provide private HTTPS access without another proxy or container.

1. Join the host to your tailnet and start the app with Docker Compose.
2. Check `tailscale serve status` so you do not replace an existing service.
3. If HTTPS port 443 is free, run `tailscale serve --bg 4180`.
   If another app uses 443, use a separate port:

   ```bash
   tailscale serve --bg --https=8443 4180
   ```

4. Open the HTTPS URL printed by Serve from a device connected to your tailnet.
   Bookmark that URL or add it to your phone's home screen.

Serve manages the HTTPS certificate and resumes after a host or Tailscale
restart. Tailnet access rules control who can reach the app. Do not enable
Tailscale Funnel, which would publish it to the internet.

Check `tailscale serve status` and `docker compose ps` after an update. To stop
only the app's HTTPS listener on port 8443, run
`tailscale serve --https=8443 off`. Do not reset all Serve routes.
