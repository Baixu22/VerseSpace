# Workbench UI E2E

These tests use the real browser, Vite frontend, and Workbench HTTP service. They do not mock API routes or inject store state, and they do not send model requests or change provider settings.

Start the backend from the repository root:

```sh
bun packages/workbench/src/index.ts ui --port 7700 --no-open
bun run dev:ui
```

Then run `bun run test:e2e` from `apps/workbench-ui`. Install the matching Playwright Chromium first, or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to an installed Chromium browser. `WORKBENCH_E2E_URL` overrides the default `http://127.0.0.1:5188`.

The draft round-trip test needs two existing conversations and records the normal switch/leave/restore events. The planning test needs a conversation in default or plan mode, temporarily toggles that mode, and restores it. Layout, tooltip, and settings tests also cover an empty workspace. Traces and screenshots for failures are saved in `test-results/`.

The dropdown persistence test is opt-in: set `WORKBENCH_E2E_CONFIG_SANDBOX=1` and point `WORKBENCH_E2E_URL` at an isolated workspace initialized with the `openai-responses` provider and `high` effort. It changes those settings to verify persistence and restoring the default. The dropdown layout and keyboard tests do not change configuration.
