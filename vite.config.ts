import path from "node:path";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const host = process.env.TAURI_DEV_HOST;
const WATCH_IGNORED = [
	"**/src-tauri/**",
	"**/.local/**",
	"**/.local-docs/**",
	"**/.vscode/**",
	"**/dist/**",
	"**/*.log",
];

// https://vite.dev/config/
export default defineConfig(async () => ({
	plugins: [
		react(),
		babel({
			plugins: [["babel-plugin-react-compiler", {}]],
		}),
		tailwindcss(),
	],
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: {
			"@": path.resolve(__dirname, "./src"),
			react: path.resolve(__dirname, "./node_modules/react"),
			"react-dom": path.resolve(__dirname, "./node_modules/react-dom"),
			"react/jsx-runtime": path.resolve(
				__dirname,
				"./node_modules/react/jsx-runtime.js",
			),
			"react/jsx-dev-runtime": path.resolve(
				__dirname,
				"./node_modules/react/jsx-dev-runtime.js",
			),
		},
	},
	optimizeDeps: {
		include: [
			"react",
			"react-dom",
			"react/jsx-runtime",
			"react/jsx-dev-runtime",
			"@tanstack/react-query",
			// Pre-bundle the icon libraries so Vite does not have to crawl their
			// per-icon ESM modules on every cold dev start. Production builds
			// already tree-shake to only the icons we actually use.
			// reicon-react is the primary set; lucide-react only backs the
			// compatibility gaps in src/components/icon/compat.ts.
			"reicon-react",
			"lucide-react",
		],
		// Lexical's package graph produces many transient dev-only chunks.
		// When Vite re-optimizes mid-session after a lockfile check, those
		// generated chunk names can drift and leave stale references behind.
		// Excluding Lexical avoids the broken half-optimized cache state.
		exclude: ["lexical", "@lexical/react"],
	},

	// Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
	//
	// 1. prevent Vite from obscuring rust errors
	clearScreen: false,
	// 2. tauri expects a fixed port, fail if that port is not available
	server: {
		port: 1420,
		strictPort: true,
		host: host || false,
		hmr: host
			? {
					protocol: "ws",
					host,
					port: 1421,
				}
			: undefined,
		watch: {
			// 3. ignore app-internal local data/docs, Rust backend, editor metadata, logs, and build artifacts
			ignored: WATCH_IGNORED,
		},
	},
	test: {
		environment: "jsdom",
		setupFiles: "./src/test/setup.ts",
		css: true,
		// The full UI suite exceeds this Windows machine's process/memory budget
		// at the default worker count; keep the normal test command reproducible.
		maxWorkers: process.platform === "win32" ? 2 : undefined,
		// GitHub Actions macos-latest runs ~50x slower than local for the
		// same spec (transform + import easily consume tens of seconds
		// before the first test runs). waitFor-heavy tests in the nav +
		// app-shortcuts suites hit microtask ordering edges under that
		// load. Retry twice in CI so a single scheduling hiccup does not
		// fail the whole run; local dev stays strict.
		retry: process.env.CI ? 2 : 0,
		hookTimeout: 60_000,
		// `bun:test` suites must not reach vitest: the runner cannot bundle the
		// `bun:test` built-in and every one of those files errors out during
		// collection. sidecar/ was excluded for this reason; packages/workbench
		// and packages/context-rot (56 spec files) are the same case and are
		// covered by `test:workbench` / `test:context-rot`.
		// Same for the Rust + fixtures trees which contain no TS tests.
		// `worktrees/` and `.claude/worktrees/` are gitignored dispatch or review
		// copies of the repo. Without both exclusions, Vitest duplicates the suite
		// and can exhaust memory while collecting agent worktrees.
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			"sidecar/**",
			"packages/**",
			"apps/**",
			"src-tauri/**",
			"fixtures/**",
			"e2e/**",
			"worktrees/**",
			".claude/worktrees/**",
			// Local audit snapshots can contain copies of other packages' tests.
			"**/.workbuddy/**",
			"**/.agent-contexts/**",
			"**/.evidence-sites/**",
			// Same for the blackboard runtime dir: agent sessions spool copies of
			// task files — including test files — under .workbench, and collecting
			// those duplicates the suite with broken relative imports (observed
			// 2026-09-20: 10 spool copies collected as test files by the root run).
			"**/.workbench/**",
		],
	},
}));
