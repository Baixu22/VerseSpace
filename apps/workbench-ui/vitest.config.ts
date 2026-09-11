import path from "node:path";
import { defineConfig } from "vitest/config";

// The dashboard's test target lives beside its sources: `vitest run` from
// apps/workbench-ui. The root vitest config deliberately excludes `apps/**`,
// so this file is the only entry — keep it dependency-free (no react plugin,
// esbuild's automatic JSX transform is enough for the component tree).
export default defineConfig({
	// Mirrors vite.config.ts so `@/components/icon` resolves under test too.
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
	test: {
		environment: "jsdom",
		setupFiles: "./src/test/setup.ts",
		css: false,
		include: ["src/**/*.test.{ts,tsx}"],
	},
});
