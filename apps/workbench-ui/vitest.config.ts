import { defineConfig } from "vitest/config";

// The dashboard's test target lives beside its sources: `vitest run` from
// apps/workbench-ui. The root vitest config deliberately excludes `apps/**`,
// so this file is the only entry — keep it dependency-free (no react plugin,
// esbuild's automatic JSX transform is enough for the component tree).
export default defineConfig({
	test: {
		environment: "jsdom",
		setupFiles: "./src/test/setup.ts",
		css: false,
		include: ["src/**/*.test.{ts,tsx}"],
	},
});
