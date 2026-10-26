import path from "node:path";
import { defineConfig } from "vitest/config";

// The dashboard's test target lives beside its sources: `vitest run` from
// apps/workbench-ui. Keep this entry dependency-free: esbuild's automatic JSX
// transform is enough for the component tree.
export default defineConfig({
	// Mirrors vite.config.ts so `@/components/icon` resolves under test too.
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
	test: {
		// One jsdom worker stays within the 16 GB Windows development host's budget.
		maxWorkers: 1,
		environment: "jsdom",
		setupFiles: "./src/test/setup.ts",
		css: false,
		include: ["src/**/*.test.{ts,tsx}"],
	},
});
