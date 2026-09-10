import { defineConfig } from "@playwright/test";

// Run against a real `workbench ui` backend and the Vite frontend.
export default defineConfig({
	testDir: "./e2e",
	fullyParallel: false,
	workers: 1,
	timeout: 30_000,
	reporter: "list",
	use: {
		baseURL: process.env.WORKBENCH_E2E_URL ?? "http://127.0.0.1:5188",
		viewport: { width: 1440, height: 1000 },
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
		launchOptions: {
			executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
		},
	},
});
