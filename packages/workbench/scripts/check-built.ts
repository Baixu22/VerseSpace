/** Smoke-test built artifacts from a different workspace, without opening a browser. */
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	args: Bun.argv.slice(2),
	options: { native: { type: "string" }, js: { type: "string" } },
});
const packageRoot = resolve(import.meta.dir, "..");
const targets = [
	{
		kind: "native",
		command: resolve(
			values.native ??
				join(
					packageRoot,
					"dist",
					process.platform === "win32" ? "workbench.exe" : "workbench",
				),
		),
		prefix: [] as string[],
	},
	{
		kind: "js",
		command: process.execPath,
		prefix: [resolve(values.js ?? join(packageRoot, "dist", "workbench.js"))],
	},
];

async function freePort(): Promise<number> {
	return new Promise((done, fail) => {
		const socket = net.createServer();
		socket.on("error", fail);
		socket.listen(0, "127.0.0.1", () => {
			const address = socket.address();
			const port = typeof address === "object" && address ? address.port : 0;
			socket.close(() => (port ? done(port) : fail(new Error("没有可用端口"))));
		});
	});
}

for (const target of targets) {
	const workspace = await mkdtemp(join(tmpdir(), "workbench-built-smoke-"));
	const cleanupPath = resolve(workspace);
	if (
		dirname(cleanupPath) !== resolve(tmpdir()) ||
		!basename(cleanupPath).startsWith("workbench-built-smoke-")
	)
		throw new Error("临时工作区路径无效");
	let server: ReturnType<typeof spawn> | undefined;
	try {
		const run = (args: string[]) => {
			const result = spawnSync(target.command, [...target.prefix, ...args], {
				cwd: workspace,
				encoding: "utf8",
				windowsHide: true,
				timeout: 10_000,
			});
			if (result.error || result.status !== 0)
				throw new Error(
					`${target.kind} ${args[0]}：${result.error ?? result.stderr}`,
				);
			return result.stdout;
		};
		run(["--json", "init", "--project", workspace]);
		await writeFile(join(workspace, "AGENTS.md"), "Read `package.json`.\n");
		await writeFile(join(workspace, "package.json"), '{"name":"built-smoke"}');
		const doctor = JSON.parse(run(["--json", "doctor"]));
		if (doctor.rot?.assertions !== 1 || doctor.rot.stale !== 0)
			throw new Error("构建产物未包含共享 context-rot 扫描器");
		const stats = JSON.parse(run(["--json", "stats"]));
		if (!stats.lifecycle?.restoreToMessage || !stats.landmarkReviews?.current)
			throw new Error("构建产物缺少当前统计字段");
		const port = await freePort();
		const base = `http://127.0.0.1:${port}`;
		server = spawn(
			target.command,
			[...target.prefix, "--quiet", "ui", "--port", String(port), "--no-open"],
			{ cwd: workspace, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
		);
		server.stdout?.resume();
		let stderr = "";
		server.stderr?.on("data", (part) => {
			stderr += String(part);
		});
		let ready = false;
		for (let attempt = 0; attempt < 50; attempt += 1) {
			if (server.exitCode !== null)
				throw new Error(`界面服务已退出：${stderr}`);
			try {
				if (
					(
						await fetch(`${base}/api/bootstrap`, {
							signal: AbortSignal.timeout(500),
						})
					).ok
				) {
					ready = true;
					break;
				}
			} catch {
				/* Startup may not have bound the port yet. */
			}
			await new Promise((done) => setTimeout(done, 100));
		}
		if (!ready) throw new Error(`界面服务未就绪：${stderr}`);
		const page = await fetch(`${base}/`, {
			signal: AbortSignal.timeout(3_000),
		}).then((response) => response.text());
		const source = page.match(/src="([^"]+\.js)"/)?.[1];
		if (!source) throw new Error(`未返回内嵌界面：${page.slice(0, 200)}`);
		const url = new URL(source, `${base}/`);
		if (url.origin !== base || !url.pathname.startsWith("/assets/"))
			throw new Error("界面资源地址不在本地服务中");
		const js = await fetch(url, { signal: AbortSignal.timeout(3_000) }).then(
			(response) => response.text(),
		);
		if (!js.includes("resume_evidence_opened"))
			throw new Error("界面资源不是当前版本");
		console.log(
			JSON.stringify({
				kind: target.kind,
				initialized: true,
				doctor: true,
				stats: true,
				headlessUi: true,
				bundledUi: true,
			}),
		);
	} finally {
		if (server && server.exitCode === null) {
			const child = server;
			await new Promise<void>((done) => {
				const timer = setTimeout(() => {
					child.kill("SIGKILL");
					done();
				}, 3_000);
				child.once("exit", () => {
					clearTimeout(timer);
					done();
				});
				child.kill("SIGTERM");
			});
		}
		await rm(cleanupPath, { recursive: true, force: true, maxRetries: 3 });
	}
}
