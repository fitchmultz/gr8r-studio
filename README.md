# Gr8r Studio

A calm, structured project management workspace: home dashboard, inbox, my tasks, projects with
board / list / table / calendar / timeline / files views, members, teams, activity and settings.

Built with plain JavaScript ES modules and CSS, bundled by [Vite](https://vite.dev). There is no
UI framework and no runtime dependency.

![Gr8r Studio home dashboard](docs/preview.png)

## Getting started

Requires Node.js 20.19+ or 22.12+ (`.nvmrc` pins 22).

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

1. `core/` and `data/` depend on nothing else in the app.
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

Keep the server behind a private network or an authenticated reverse proxy.
Anyone who can reach `/api/config` can obtain the shared token and read or
change the workspace. The token is not a user login.

```bash
VITE_SYNC_URL=/api npm run build
cd server && GR8R_TOKEN=<secret> npm start    # app + sync API on 127.0.0.1:4180
```

- `GR8R_TOKEN` is the single shared bearer token. The client fetches it from
  `GET /api/config` at startup, so rotating it only needs a server restart.
  `PORT`, `HOST`, `GR8R_DATA`
  (state file) and `DIST` (static dir) can be overridden through the environment.
- The server keeps the workspace blob and a revision in `server/data/state.json`.
  `POST /api/sync` accepts a push whose `baseRev` matches the current revision
  and answers `409` with the newer state otherwise; the client then adopts it.
- Clients save locally first, push (debounced) on every change, and pull at boot,
  every 30 seconds, and when another tab on the same device changes state.
- Two devices that edit offline at the same time: the last push wins, and the
  earlier device's offline edits are replaced when it reconnects.

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
