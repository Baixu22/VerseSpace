# AGENTS.md

This file provides guidance to AI coding agents working with code in this repository.

## What this repo is

**VerseSpace** is the local-first IDE for coding agent orchestration. Its mainline is
**Workbench** — a CLI + filesystem state manager that keeps a *premise ledger*: it records
which files agents, humans and git have read and written, and produces evidence when a
recorded premise goes stale. State lives inside the project under `.workbench/` (YAML +
JSONL) — no database, no required editor. Agents are notified over MCP + stdin; humans get
a resume card; questions the system cannot answer go to a tribunal queue.

Three packages ship from this monorepo:

| Path | Package | What it is |
| --- | --- | --- |
| `packages/workbench` | `@baixu22/workbench` | The ledger + orchestration CLI, plus the local dashboard server (`workbench ui`). Bun + TypeScript, built to a single-file binary. |
| `apps/workbench-ui` | `@baixu22/workbench-ui` | The dashboard frontend served by `workbench ui`. Vite + React 19, embedded into the binary. |
| `packages/context-rot` | `context-rot` | Standalone doctor that finds dead code references in `AGENTS.md` / `CLAUDE.md` / `.cursorrules`. Also the scanner the workbench `doctor` reuses. |

> **The legacy Helmor desktop app is gone.** `src/` (React SPA), `src-tauri/` (Tauri v2 + Rust +
> SQLite) and `sidecar/` (Bun agent-SDK wrapper) were deleted on 2026-09-21 under
> [ADR-0014](docs/decisions/0014-legacy-retirement-gate.md) (the gate) and
> [ADR-0015](docs/decisions/0015-legacy-retirement-execution.md) (the execution). Read them at
> commit `944b9d6` or earlier (the last commit before the retirement landed).
>
> Do **not** re-introduce Tauri, Rust/`cargo`, or a sidecar process into the mainline. If a task
> appears to require one, say so rather than adding it.

## Commands

```bash
bun install                  # Install deps (bun 1.3.14, pinned in `packageManager`)
bun run typecheck            # tsc --noEmit across all three packages
bun run lint                 # biome check .
bun run lint:fix             # biome check --write
bun run test                 # all three suites: workbench -> workbench-ui -> context-rot
bun run dev:ui               # vite dev server for the dashboard
bun run build:ui             # build the dashboard, then embed it into the workbench package
bun run icons                # regenerate the shared icon layer
bun run release:tag:workbench  # dry-run the workbench release tag (add --push to really publish)
```

Individual suites:

```bash
bun run test:workbench       # cd packages/workbench && bun test --timeout 60000
bun run test:workbench-ui    # cd apps/workbench-ui && vitest run
bun run test:context-rot     # cd packages/context-rot && bun test --timeout 60000
```

Single test file: `cd packages/workbench && bun test src/cli.test.ts` |
`cd apps/workbench-ui && bunx vitest run src/App.test.tsx`

Pre-commit runs `lint-staged` (Biome on JS/TS/JSON/CSS). There is **no Rust lane** — `cargo`,
`clippy` and `insta` are no longer part of this repo.

### CI remotes (GitHub Actions blocked → GitLab CI)

GitHub still hosts the repo, PRs and Releases. **Continuous integration runs on GitLab.com**
because the GitHub private-repo Actions billing/spending limit is exhausted — jobs never get a
runner (PR #28, also recorded in `docs/integrity-fixes-closeout-2026-09-16.md`).

| Remote | URL | Role |
| --- | --- | --- |
| `origin` | `https://github.com/Baixu22/VerseSpace.git` | PRs, Releases, source of truth for merge |
| `gitlab` | `https://gitlab.com/Baixu22/VerseSpace.git` | CI (`.gitlab-ci.yml`, shared runners) |

A branch that needs CI is pushed to **both** remotes:

```bash
git push origin <branch>   # updates the GitHub PR
git push gitlab <branch>   # runs the GitLab pipeline
```

Local git is wired so HTTPS pushes to `gitlab.com` authenticate through glab
(`credential.https://gitlab.com.helper` → `glab auth git-credential`). `glab` lives at
`D:\software\glab\glab.exe` and is already logged in as `Baixu22`.

Quirk to know: GitLab.com free accounts must complete **identity verification** before *GitLab-hosted* CI jobs will start, and phone SMS is **Unsupported for China (+86)** — so hosted runners are not available here. The workaround is a **self-managed project runner** on this Windows machine (documented alternative in GitLab's identity-verification troubleshooting):

- Binary/config: `D:\software\gitlab-runner\` (`gitlab-runner.exe`, `config.toml`, `start-runner.bat`)
- Runner id `56555227`, tags `verspace-local` / `windows` / `self-hosted`
- Executor: `shell` + **`pwsh`** (PowerShell 7 portable at `D:\software\PowerShell\pwsh-dir`) — Windows PowerShell 5.1 cannot parse the runner's UTF-8 env files on a zh-CN host
- Uses the machine's Bun at `C:\Users\27933\AppData\Roaming\npm\node_modules\bun\bin`
- Project has `shared_runners_enabled=false` so jobs cannot fall through to SaaS
- Start if not running: `D:\software\gitlab-runner\start-runner.bat` (sets PATH then `gitlab-runner run`)
- **The machine must be on** for CI to pick up jobs; `concurrent=1` by design (16 GB host)

Validate config with `glab ci lint .gitlab-ci.yml -R Baixu22/VerseSpace`.

### Package-local commands worth knowing

```bash
cd packages/workbench
bun run build                # local binary + npm JS package + UI assets
bun run test:build           # verify both build shapes in an isolated workspace (needs build first)
bun run build:all            # cross-compile four platform binaries into dist/
bun run test:live            # live-model E2E; needs E2E_LLM_KEY / E2E_LLM_MODEL (see README)
```

`bun run test:live` calls a third-party model service and does **not** run under plain
`bun test`. Read `packages/workbench/README.md` before running it — the default model does not
clear the full acceptance bar, and the model/endpoint/key are a matched set.

## Architecture

### `packages/workbench` — the ledger and its CLI

Entry point is `src/index.ts` → `buildProgram()` in `src/cli.ts`, which registers five
**commander** command groups (`src/cli/{foundation,agents,mcp,tribunal,workspace}.ts`). Every
subcommand lives in `src/commands/` and supports `--json` / `--quiet`.

| Module | Role |
| --- | --- |
| `blackboard/` | **The single data layer.** Goals, decisions, interfaces registry, state, checkpoints, events. Every other module reads and writes through it. |
| `automaton/` | State machines for goals, workspots and checkpoints, plus the evaluator that advances them. |
| `runtime/` | One runtime pass: acquire the run lock, apply transitions, reconcile premises, emit events. |
| `scheduler/` | Dispatch, dispatch guards/recovery, merge guard, branch-in-use, WIP, notifications, tick. |
| `verifier/` | Runs a checkpoint's declared verification strategy and classifies the result (`passed` / `failed` / `needs_human` / `timeout` / `skipped`). |
| `supervisor/` | Process supervision: spawn, liveness watch, crash-loop detection, orphan reaping. |
| `chat/` | Chat lanes — two supervised-CLI lanes (`claude` and `codex`, both with tool footprints) plus three HTTP lanes (`openai-chat`, `openai-responses`, `anthropic`, not observable), streaming, render state, threads, branch engagement, stats. The `claude` lane spawns the read-only ledger MCP server into the CLI (`claude-mcp.ts` → `--mcp-config`), so the model can query premises/footprints/resume_cards/tribunal/notices mid-turn; `WORKBENCH_CLAUDE_MCP=off` opts out. The `codex` lane supervises `codex app-server` over JSON-RPC-on-stdio (`codex-app-server.ts`): permission requests are auto-accepted because the request *is* the read/write claim, user-input requests are auto-declined so a turn cannot wedge — see [ADR-0017](docs/decisions/0017-second-observable-provider-integration.md). Premise notices folded into a turn are also recorded as `notice` parts on that user message. The Cursor / Kimi / OpenCode stream fixtures under `chat/fixtures/streams/` are retained protocol samples, **not** adapters; the Codex fixtures now have a consumer (`codex-fixtures.test.ts`). |
| `agents/` | Spawns agent sessions, captures their tool footprints, records per-session usage. |
| `interactions/` | The user-feedback side: interest/context derivation, landmark projection, review queue, review stats (DOI). |
| `tribunal/` | The human-decision queue: kinds, escalation, rationalization, queue store/stats, envelopes. |
| `contextgen/` | Generates the per-workspot `.agent-context.md` from the workspot's declared `contextNeeds`. |
| `doctor/` | Whole-ledger consistency checks; non-zero exit makes it usable as a CI gate. |
| `rot/` | Adapts the `context-rot` scanner into the doctor's unique-path report. |
| `mcp/` | stdio MCP server exposing five **read-only** ledger tools: `premises`, `footprints`, `resume_cards`, `tribunal`, `notices`. |
| `ui/` | The dashboard HTTP server: `server.ts`, chat routes, workspace routes, evidence route, promotion route, chat config, embedded assets. |
| `watcher/` | chokidar-based watch mode — file changes trigger a runtime pass. |
| `git/` | Thin, never-throwing git runner (worktrees, `merge-tree`, refs). |
| `fs/` | `atomic.ts` (atomic write/rename, with `EBUSY`/`EPERM` retry) and `lockfile.ts` (run locks). |
| `types/` | Shared types + zod schemas: config, goal, checkpoint, workspot, state, snapshot, transitions, tribunal, interface registry, event, session. |

`src/commands/` holds one module per subcommand (`goal`, `decision`, `interface`, `ws`,
`checkpoint`, `dispatch`, `sync`, `doctor`, `sessions`, `premises`, `context`, `wip`, `restore`,
`config`, `init`, `interest`, `agent`, `ui`, `watch`, `stats`, `tribunal`, `seal-review`).

### `apps/workbench-ui` — the dashboard

| Path | Role |
| --- | --- |
| `chat/` | Chat store (zustand) + stream reducer + thread / resume / draft / selection slices + the `@assistant-ui` adapter. |
| `components/chat/` | Chat surface components. |
| `components/icon/` | **Generated** icon layer — never edit by hand, see the Icons bullet. |
| `components/ui/` | shadcn/ui primitives. |
| `lib/utils.ts` | `cn()` — clsx + tailwind-merge, with the typography tokens registered. |
| `styles/` | `theme.css` (vendored token subset, with its Apache-2.0 origin notice), `interactions.css`, `chat.css`. |
| `e2e/` | Playwright specs + `playwright.config.ts`. |

### `packages/context-rot` — the doctor

`scan.ts` (discovery + orchestration), `extract.ts` (pull inline code spans out of instruction
files), `file-index.ts` (repo-wide file/symbol index), `path-refs.ts` (bare-path regex),
`verify.ts` (existence checks). `cli.ts` is the standalone entry point. It additionally checks
symbols and package names; the workbench `doctor` reuses the path checks only.

**Cross-package coupling to be aware of:** `packages/workbench/src/rot/scan.ts` imports
directly from `../../../context-rot/src/scan` and `.../file-index`. Both single-file builds
bundle the shared source, so neither installed package needs the other at runtime — but a change
to `packages/context-rot/**` must be validated against **both** test suites (wired in
`.github/workflows/ci.yml`).

### Data flow

```
agent writes        agent CLI --> capture --> blackboard.footprints --> events.jsonl
human writes        git / editor --> sessions record -------------------^
                                                          |
runtime pass        events --> runtime/apply --> premise reconciliation --> notices
                                                          |
surfaces            CLI --json  |  MCP read-only tools  |  dashboard HTTP routes
```

`.workbench/` layout:

```
.workbench/
├── workbench.yaml            # config (scheduling policy, protected paths, thresholds)
├── blackboard/               # the single data layer
│   ├── goals/*.yaml          # goals (state machine + dependencies + interface anchors)
│   ├── decisions/*.yaml      # architectural decisions (append-only)
│   ├── interfaces/registry.yaml
│   └── state/                # workspots, execution queue, known conflicts
├── checkpoints/              # staging / verified / failed
└── events/events.jsonl       # append-only audit log
```

## Key conventions

- **Workbench is a CLI-first product.** The dashboard is a surface over the same ledger, not a
  second source of truth. New capability lands in the package first; the UI consumes it.
- **Append-only where it matters.** Decisions and events are never rewritten — corrections are
  new entries that supersede. Preserve this when adding anything to `blackboard/`.
- **`--json` on every command.** Machine-readable output is part of the contract, not an extra.
- **Linting**: Biome, tab indent. `lint-staged` enforces on pre-commit.
- **Testing**: `bun test` for `packages/workbench` and `packages/context-rot`; Vitest + jsdom
  for `apps/workbench-ui`. Tests are co-located with source.
- **Icons**: import every icon from `@/components/icon` — never `reicon-react` or `lucide-react`
  directly. Reicon is the primary set; `compat.ts` holds the glyphs Reicon does not ship (git
  branch/PR/merge/fork, panel-collapse, keyboard keys like ⇧/⌘/⌫) and stays on lucide. The layer
  is generated from one mapping table: add the icon to `scripts/gen-icon-layer.mjs`, run
  `bun run icons`, and it regenerates `apps/workbench-ui/src/components/icon/` — failing loudly
  if Reicon has no such icon. Icons are re-exported under the identifiers the codebase already
  uses, so call sites keep their `size` / `className` / `strokeWidth` props unchanged. Agents can
  search Reicon through the `reicon` MCP server (see `docs/reicon-icons.md`).
- **Styling (dashboard)**: Tailwind CSS v4. Tokens live in
  `apps/workbench-ui/src/styles/theme.css` — a **vendored subset** of the retired Helmor theme,
  carrying only the Base + shadcn-protocol tokens the dashboard consumes. That file carries an
  Apache-2.0 §4(b) origin-and-change notice; do not strip it. `src/index.css` maps the tokens
  into Tailwind utilities via `@theme` / `@theme inline`.
- **Typography**: use semantic tokens (`text-nano` … `text-heading`), not `text-[Npx]`. New
  font-size tokens must also be registered with tailwind-merge in
  `apps/workbench-ui/src/lib/utils.ts`, otherwise `cn("text-{token} text-{color}")` collapses
  to just the color.
- **Cursor**: clickable elements default to `cursor-pointer` (baked into the base UI
  components; keep it on custom `<div onClick>` too).
- **Chat rendering**: `@assistant-ui/react` + `streamdown`.
- **Releases**: the workbench package's public shape is the **single-file binary**
  (`workbench-v*` tag → four-platform build → GitHub Release). The npm shape is not published
  yet. Use `bun run release:tag:workbench`; pushing the tag is a real publish action, so confirm
  the version and `CHANGELOG.md` first. **`.changeset/` no longer exists** — bump the version and
  write the changelog entry by hand. **While GitHub Actions has no runner** (quota, see CI
  remotes above) the tag script pushes to both remotes and the build runs in the `release` stage
  of `.gitlab-ci.yml`: `release-build` cross-compiles all four binaries on the Windows runner,
  then the **manual** `release-publish` job runs `scripts/publish-workbench-release.mjs`, which
  attaches them plus `SHA256SUMS` to the GitHub Release and states in the notes that only
  windows-x64 ran the test suite. `release-workbench.yml` stays as the per-platform lane for
  when Actions comes back.
- **Licensing**: `@baixu22/workbench` is `MIT AND Apache-2.0`. `scripts/build.ts` copies
  `NOTICE` / `LICENSE` / `LICENSE-APACHE` into `dist/`, the package `files` field keeps them in
  the tarball, and both release lanes (`release-workbench.yml`,
  `scripts/publish-workbench-release.mjs`) attach them to the Release. Apache-2.0 §4(d)
  requires a readable `NOTICE` at distribution time — do not delete those files.
- **"Helmor" and the Helmor logo are trademarks** of Caspian Zhao and Nathan Lian. The Apache-2.0
  grant covers use, modification and redistribution of the source, but **not** use of the name or
  logo to identify this product or a derivative — which is why the package ships as
  `@baixu22/workbench`.

## 🚨 Code organization rules

**Never let a single file grow into a monolith.** Follow these rules strictly:

1. **One responsibility per file.** If a file handles two unrelated concerns, split it.
2. **Use module directories.** When a module grows beyond ~300 lines, convert it to
   `foo/index.ts` + focused sub-files. `blackboard/`, `chat/`, `scheduler/`, `tribunal/` and
   `interactions/` are the reference pattern.
3. **Commands vs. domain logic.** A `src/commands/<name>.ts` file is CLI glue: parse options,
   call domain modules, format output. Business logic belongs in its own module. Do not mix the
   two.
4. **When in doubt, split.** It is always easier to merge two small files than to untangle a
   1000-line monolith.

## Local environment caveats (Windows dev machine)

These are **machine-local defects, not repo bugs**. They change what "green" means on this
machine; CI is unaffected. Documented so a green local run is not misread as proof CI is green.

### Injected HTTP proxy breaks loopback tests

The host injects `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` into every shell session, pointing at
a local proxy port captured **at session start** — so it does not follow the user changing ports.
Bun's `fetch` routes even `127.0.0.1` through it, so every HTTP-based workbench test
(`ui/server.test.ts`, `chat/threads.test.ts` resume routes, `ui/chat-routes`, …) fails in bulk
with `ConnectionRefused` / `errno: 0` — easily misread as "the server isn't binding".
**This is not a code regression.**

```bash
# Preferred: bypass the proxy for loopback (survives a stale injected port)
NO_PROXY="127.0.0.1,localhost,::1" bun test
# or: env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY bun test
```

Probing a proxy needs a real target — `curl http://127.0.0.1:<port>` returning `000` does **not**
mean the proxy is down. Use `curl -x http://127.0.0.1:<port> https://example.com`.

### Test teardown under real-time scanning

Windows real-time scanning holds handles on a freshly written git repository (`.git` is written
file by file, each one scanned), so `rm` on that directory can fail with `EBUSY` for ~15s or more
*after* a test's assertions have already passed. `packages/workbench/src/rot/scan.test.ts` retries
and then warns instead of failing; `packages/workbench/src/fs/atomic.ts` already retries
`EBUSY`/`EPERM`/`EACCES` for the same reason. A lone teardown `EBUSY` is environmental.

### `git rm` on a directory can delete siblings (host file-operation defect)

Some hosts turn nonempty-directory deletion into success, after which Git's empty-parent cleanup
removes siblings. On 2026-09-14 native probes with Git 2.51, 2.53 and MinGit 2.55 preserved the
sibling file; on 2026-09-15 the failure was reproduced through WorkBuddy's bundled sandbox.
**The mainline still does real git operations, so this still matters.**

The judging criterion is the *behaviour*, not the module list. Measured on 2026-09-21: a shell
that had `tsbx.dll` loaded still passed the probe (nonempty `rmdir` refused, error 145, siblings
and refs intact). Do not claim "`tsbx.dll` is loaded" as evidence of the fault — measure it.

Check the actual host:

```bash
powershell.exe -NoProfile -File scripts/win/check-git-filesystem.ps1
```

It keeps only its own fixture and returns `1` for corruption even when Git exits `0`.

`packages/workbench/src/git/host-filesystem.ts` is the same probe in-process, and
`packages/workbench/src/git/index.ts` wires it into `git()`: while the host is judged unsafe,
read-only verbs still run, but anything that could rewrite the worktree or refs fails loudly
with a message naming TF-0173 instead of corrupting silently. On a healthy host the guard is
inert. `WORKBENCH_GIT_HOST_GUARD=off` disables it; `force-unsafe` / `force-clean` force the
verdict for tests.

The narrow workaround for agents running git by hand is `git rm --cached` plus removal of exactly
the intended file. `packages/workbench/scripts/e2e/scenario.ts` stages its deletion this way on
purpose: the index outcome is identical, but the temporary fixture's siblings survive.
**Do not "simplify" it back to `git rm`.**

### Git refs: slash-nested branches and remote-tracking refs

Two related failures come from the same defect — Git attempts empty-parent cleanup when releasing
ref locks:

- `git branch ws/probe` exits 0 but creates no ref; `git worktree add -b ws/ws-a` then fails with
  `fatal: invalid reference: ws/ws-a`. Slash-free branch names work.
- `git update-ref refs/remotes/origin/main` returns 0 without writing the file, so `origin/main`
  keeps vanishing and `git status` shows `[gone]`.

Manual recovery: `mkdir -p .git/refs/remotes/origin && git rev-parse main > .git/refs/remotes/origin/main`
(loose refs take precedence over `packed-refs`). `scripts/git-ref-repair.sh` automates this.
Diagnose the host with the regression script above instead of assuming every Windows git failure
has this cause.

### Bun version

Pinned to **1.3.14** in `package.json` (`packageManager`), `.github/actions/setup-js/action.yml`,
and `.github/workflows/release-workbench.yml`. Two version-bound behaviours must be re-checked on
any bump: `fetch` connection-pool reuse across ports, and the HTTP layer rejecting illegal
percent-encoding (`%ZZ`) before the request handler runs — see
`packages/workbench/src/ui/server.ts` and `ui/evidence-route.test.ts`.

### Windows test concurrency

Keep heavy builds and the full UI suite from running at the same time on this 16 GB machine. The
full dashboard suite otherwise exceeds the local process/memory budget and times out tests at the
existing limits. Audit copies under `.workbuddy`, `.agent-contexts` and `.evidence-sites` are
excluded from collection.

## Where the project's own records live

- **`docs/decisions/`** — the ADR set. One decision per file, numbered, append-only; superseding a
  decision means adding a new one and noting the relationship. `docs/decisions/README.md` indexes
  them and maps each to its task-forest node. **Read the ADRs before proposing an architectural
  change.**
- **`.agent-workbench/task-forest/`** — the task forest: the authority for what is planned and what
  is done. Canonical state is `graph/nodes.json` + `graph/edges.json` + `config.json` +
  `events/events.jsonl`; exports are derived and rebuildable.
- **`docs/*.md`** — historical reports and evidence records. Most are **point-in-time readings**,
  not current state. Check the date in the filename before treating one as authoritative.
- **`.agent-contexts/`** — local session scratch, mostly gitignored.
