# Workbench UI E2E

## Test categories (TF-0258 / F-07)

Three surfaces, three reports — never merged into one "UI green":

| Category | Where | What a green run proves |
| --- | --- | --- |
| Route contract | `packages/workbench/src/ui/*.test.ts`, `scheduler/dispatch-guard.test.ts` | the HTTP endpoint behaves — **not** that the dashboard reaches it |
| Browser E2E | this directory (`bun run test:e2e`) | a real Chromium drives the real Vite UI against the real backend |
| Real-provider E2E | `packages/workbench` `bun run test:live` | a real model/provider completes a turn |

A route-contract green is **not** product evidence: `/api/sync`, `/api/dispatch`,
`/api/agent/run` and `/api/review` are CLI-equivalent endpoints the SPA never
calls (`packages/workbench/src/ui/workspace-routes.ts:1-6`, TF-0244 deprecated).
The provider option count in `dropdown.spec.ts` is derived from
`../src/chat/providers.ts` (TF-0255) so it cannot drift from the panel again.

These tests use the real browser, Vite frontend, and Workbench HTTP service. They do not mock API routes or inject store state, and they do not send model requests or change provider settings.

## Running it

One command does the whole thing — isolated workspace, both servers, the spec's
preconditions, Playwright, then teardown:

```sh
pwsh -NoProfile -File scripts/win/e2e-browser.ps1            # 15 tests, 0 skipped
pwsh -NoProfile -File scripts/win/e2e-browser.ps1 -KeepWorkspace   # keep the workspace + logs
pwsh -NoProfile -File scripts/win/e2e-browser.ps1 -ApiPort 7800 -UiPort 5288
```

It creates a temp workspace, runs `workbench init` there, configures the opt-in
lane, starts the backend on `-ApiPort` and Vite on `-UiPort` (both movable, so a
run does not collide with whatever you already have running), seeds five
conversations, creates current/stale/unknown artifact-review fixtures through
the real blackboard and fixed-file verifier, runs `playwright test`, and kills
the process tree. The artifact test also captures one success screenshot per
state after asserting the shared projection.
Exit code is Playwright's. **This is what the `workbench-ui-e2e` CI job runs** —
the job is a thin wrapper, not a separate script nobody has executed.

To drive it by hand instead, start the backend from the repository root and run
`bun run test:e2e` from `apps/workbench-ui`:

```sh
bun packages/workbench/src/index.ts ui --port 7700 --no-open
bun run dev:ui
```

Install the matching Playwright Chromium first, or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE`
to an installed Chromium browser. `WORKBENCH_E2E_URL` overrides the default
`http://127.0.0.1:5188`; `WORKBENCH_API_TARGET` and `WORKBENCH_UI_DEV_PORT` move
the Vite proxy target and port.

The draft round-trip test needs two existing conversations and records the normal switch/leave/restore events. The planning test needs a conversation in default or plan mode, temporarily toggles that mode, and restores it. Layout, tooltip, and settings tests also cover an empty workspace. Traces and screenshots for failures are saved in `test-results/`.

**A missing precondition is a failure with a reason, not a skip** (TF-0255):
both of those tests assert their precondition with a message, so "this scenario
never ran" cannot hide behind a `-` in the report. The runner seeds the two
conversations precisely so the default run is green.

The dropdown persistence test is opt-in: set `WORKBENCH_E2E_CONFIG_SANDBOX=1` and
point `WORKBENCH_E2E_URL` at an isolated workspace initialized with the
`openai-responses` provider and `high` effort. It changes those settings to verify
persistence and restoring the default. The dropdown layout and keyboard tests do
not change configuration.

That lane **restores the workspace it was given** (`effort` back to `high`), so it
is re-runnable — before 2026-09-25 it consumed its own precondition and a second
run against the same workspace failed at the "推理力度 = 高" assertion. The runner
still hands it a fresh workspace each time, which is the cleaner contract.
