---
name: gr8r-studio
description: Read, search, create, and update Gr8r Studio projects, tasks, subtasks, comments, and activity through the gr8r CLI and domain API. Use when planning, inspecting, or updating tasks and slices in Gr8r Studio.
---

# Gr8r Studio (`gr8r`)

Use the zero-dependency `gr8r` CLI to inspect and update Gr8r Studio workspaces atomically. Never overwrite whole workspace blobs with `/api/sync` when creating or updating projects, tasks, subtasks, or comments—use `gr8r` (or the `/api/projects` and `/api/tasks` domain endpoints) so open browser tabs receive live SSE updates without losing local state.

## Running the CLI

Run `gr8r` directly (installed at `~/.local/bin/gr8r`), or invoke the bundled script relative to this skill directory if `~/.local/bin` is not on `PATH`:

```bash
gr8r status
# Fallback when ~/.local/bin is not on PATH:
node <SKILL_DIR>/../../cli/gr8r.js status
```

In cloud `pi-durable` chats (which are not directly on the tailnet), run `gr8r` through `local_device` (`action: "execute"`, `tool: "bash"`, `args: { command: "gr8r ..." }`) on an online personal device (`alienarchy`, `m1-mbp`, or `mitchs-m5-mbp`).

## Endpoint, Auth, and Tailscale Proxy Resolution

Gr8r Studio runs on Alienarchy and is served privately across the tailnet via Tailscale Serve at `https://alienarchy.tail854973.ts.net:8443` (do not target `127.0.0.1:4180` from client devices). `gr8r` resolves connection settings automatically:

1. **Server URL:** `--url <url>`, `GR8R_URL`, `~/.config/gr8r/config.json` (`"url"`), or `https://alienarchy.tail854973.ts.net:8443`.
2. **Token:** `--token`, `GR8R_TOKEN`, `~/.config/gr8r/config.json`, or fetched automatically from `GET <url>/api/config` on private Tailscale Serve / loopback routes (refreshing once on `401`). Non-Tailscale routes withhold `/api/config` bootstrap and require `GR8R_TOKEN` or `--token`.
3. **Proxy:** `--proxy`, `GR8R_PROXY`, `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, or `~/.config/gr8r/config.json` (`"proxy"`), routed through Node's built-in `http.Agent` / `https.Agent` `proxyEnv` support. When a `*.ts.net` hostname cannot connect directly (for example on split-Tailscale machines running `ts-personal`), `gr8r` automatically falls back to `http://127.0.0.1:1055`.

Check connectivity and configured defaults at any time:

```bash
gr8r config show
gr8r status
```

## Common Workflows

All commands accept human keys (`PID`, `PID-201`, `me`, `none`) as well as internal IDs, and support `--json` for structured output.

### Inspect projects and tasks

```bash
gr8r projects
gr8r project view PID
gr8r tasks -p PID -s open
gr8r task view PID-201
gr8r search "UsageDoc"
gr8r activity -p PID --limit 20
```

### Create a project or task (with Markdown descriptions)

Pass multi-line Markdown descriptions over stdin (`--desc -`) so headings (`####`), bold (`**`), inline code (`` ` ``), fenced code blocks, lists, and `https://` links convert cleanly into the drawer's rich-text format without shell-quoting issues:

```bash
gr8r project create "Pi Durable" --key PID --status active

gr8r task create "Slice 1: Usage Ledger" \
  -p PID \
  --priority high \
  -a me \
  -l backend,frontend \
  --due 2026-11-16 \
  --subtask "Wire projection" \
  --subtask "Add tests and verify live" \
  --desc - <<'EOF'
#### Goal

Surface **UsageDoc** totals in `chat-projection.ts`.

- Include root turns and child runs
- Verify light and dark themes
EOF
```

Valid vocabulary values (verify with `gr8r status` if unsure):

- **Task status:** `backlog`, `todo`, `progress`, `review`, `done`, `canceled` (`open` is accepted as a filter on `gr8r tasks` and excludes both `done` and `canceled`)
- **Priority:** `urgent`, `high`, `medium`, `low`, `none`
- **Labels:** workspace-editable (`gr8r labels` lists current labels; `gr8r label create <name> [--color indigo]` adds custom labels)
- **Project status:** `planning`, `active`, `risk`, `hold`, `complete`

### Track progress, subtasks, and verification receipts

```bash
# Move a task to In Progress
gr8r task start PID-201 -a me

# Check off a subtask (find subtask IDs via `gr8r task view PID-201`)
gr8r subtask done PID-201 s_01_1 --note "Shipped in PR #42"

# Add a new subtask or promote one to a full task
gr8r subtask add PID-201 "Run production smoke check"
gr8r subtask promote PID-201 s_01_2

# Create or filter parent/child sub-issues inside a project
gr8r task create "Sub-slice: Schema migration" -p PID --parent PID-201
gr8r tasks -p PID --parent PID-201
gr8r tasks -p PID --parent none

# Record PR/deploy verification in comments and complete the task
gr8r task done PID-201 --comment "Merged PR #42 (sha abc1234) and verified live."

# Cancel a superseded or out-of-scope task without deleting its rationale
gr8r task cancel PID-201 --comment "Superseded by PID-204."

# Update fields, dependencies, or append Markdown notes
gr8r task update PID-202 --add-dep PID-201 --due 2026-11-18 --append-desc - <<'EOF'
#### Follow-up

Confirmed SSE updates land immediately.
EOF

# Link or sync a GitHub PR to KEY-123 tasks (also runs automatically every 60s on Alienarchy)
gr8r pr-sync --repo fitchmultz/pi-durable --pr 447 --title "feat: autofix (PID-206)" --state open
```
