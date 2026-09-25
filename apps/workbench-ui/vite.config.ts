import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev server proxies /api to the `workbench ui` backend so no CORS is needed
// while iterating on the dashboard.
export default defineConfig({
	plugins: [react(), tailwindcss()],
	base: "./",
	// Mirrors the root app so `@/components/icon` resolves in both frontends.
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
	server: {
		// TF-0255: the browser-E2E runner starts its own backend and Vite, so both
		// ports have to be movable — a fixed 7700/5188 collides with whatever the
		// developer already has running. Defaults are unchanged.
		port: Number(process.env.WORKBENCH_UI_DEV_PORT ?? 5188),
		proxy: {
			"/api": process.env.WORKBENCH_API_TARGET ?? "http://127.0.0.1:7700",
		},
	},
});
