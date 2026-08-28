import { spawn } from "node:child_process";
import type { Command } from "commander";
import { emitJson, type GlobalOptions } from "../output";
import { createUiServer } from "../ui/server";
import { resolveBlackboard } from "./context";

function openBrowser(url: string): void {
	const cmd =
		process.platform === "win32"
			? "start"
			: process.platform === "darwin"
				? "open"
				: "xdg-open";
	try {
		if (process.platform === "win32") {
			spawn("cmd", ["/c", "start", "", url], {
				detached: true,
				stdio: "ignore",
			}).unref();
		} else {
			spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
		}
	} catch {
		// best effort only — the URL is printed regardless
	}
}

export async function uiCommand(
	options: { port?: string; uiDir?: string },
	command: Command,
): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const bb = await resolveBlackboard();
	const port = Math.max(
		1,
		Math.min(65535, Number(options.port ?? 7700) || 7700),
	);
	const url = `http://127.0.0.1:${port}`;

	let server: ReturnType<typeof createUiServer>;
	try {
		server = createUiServer(bb, port, options.uiDir);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("EADDRINUSE")) {
			throw new Error(
				`端口 ${port} 已被占用（可能已有一个 workbench ui 在运行），用 --port 换一个端口`,
			);
		}
		throw error;
	}

	if (opts.json) {
		emitJson({ ok: true, url, stop: "Ctrl+C" });
	} else if (!opts.quiet) {
		console.log(`workbench ui：${url}（只读本地面板，Ctrl+C 退出）`);
	}
	openBrowser(url);

	const shutdown = (signal: string) => {
		if (!opts.quiet) {
			console.log(`\nworkbench ui：收到 ${signal}，正在退出…`);
		}
		server.stop(true);
		process.exit(0);
	};
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
}
