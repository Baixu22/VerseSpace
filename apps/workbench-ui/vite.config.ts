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
		port: 5188,
		proxy: {
			"/api": "http://127.0.0.1:7700",
		},
	},
});
