import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { scanRepo } from "./scan";

const roots: string[] = [];
async function fixture(files: Record<string, string>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "context-rot-scan-"));
	roots.push(root);
	for (const [path, content] of Object.entries(files)) {
		await mkdir(join(root, path, ".."), { recursive: true });
		await writeFile(join(root, path), content);
	}
	return root;
}

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await rm(root, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 250,
		}).catch((error: NodeJS.ErrnoException) => {
			if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(error.code ?? ""))
				throw error;
			console.warn(`[scan.test] 临时目录仍被占用：${root}`);
		});
	}
});

test("共享路径扫描包含嵌套指引、链接和行号，剔除占位符与围栏示例", async () => {
	const root = await fixture({
		"docs/AGENTS.md":
			"see [live](src/live.ts#L1) and `src/missing.ts:3`\n`foo.rs`\n~~~\n`src/example.ts`\n~~~",
		".github/instructions/review.md":
			"use `src/live.ts` and `src/second-missing.ts`",
		"src/live.ts": "export const LiveComponent = 1;",
	});
	const result = await scanRepo(root);
	expect(result.docs).toEqual([
		".github/instructions/review.md",
		"docs/AGENTS.md",
	]);
	expect(result.stale.map((ref) => ref.text).sort()).toEqual([
		"src/missing.ts",
		"src/second-missing.ts",
	]);
	expect(result.total).toBe(4);
});

test("已删但仍在 git 索引中的路径是失效，忽略的中文产物单独计数", async () => {
	const root = await fixture({
		"AGENTS.md": "`src/deleted.ts` and `构建/输出.ts`",
		".gitignore": "构建/\n",
		"src/deleted.ts": "export {};",
	});
	execFileSync("git", ["init", "-q"], { cwd: root, windowsHide: true });
	execFileSync("git", ["add", "AGENTS.md", ".gitignore", "src/deleted.ts"], {
		cwd: root,
		windowsHide: true,
	});
	await rm(join(root, "src/deleted.ts"));
	const result = await scanRepo(root);
	expect(result.stale.map((ref) => ref.text)).toEqual(["src/deleted.ts"]);
	expect(result.generated).toBe(1);
});

test("单文件 Node 产物能验证符号，不依赖 Bun 全局对象", async () => {
	const root = await fixture({
		"AGENTS.md": "use `LiveComponent`, `packageManager` and `DeadSymbol`",
		"src/live.ts": "export const LiveComponent = 1;",
		"package.json": '{"packageManager":"bun@1.3.14"}',
	});
	const built = await Bun.build({
		entrypoints: [join(import.meta.dir, "scan.ts")],
		target: "node",
		outdir: join(root, "dist"),
	});
	expect(built.success).toBe(true);
	await writeFile(join(root, "dist/package.json"), '{"type":"module"}');
	// Embed paths in the eval source: process.argv layout under `node -e`
	// differs across hosts, and agent/CI PATHs may not resolve bare `node`.
	const scanUrl = pathToFileURL(join(root, "dist", "scan.js")).href;
	const code = `const {scanRepo}=await import(${JSON.stringify(scanUrl)}); process.stdout.write(JSON.stringify(await scanRepo(${JSON.stringify(root)})));`;
	const nodeBin = process.env.CONTEXT_ROT_NODE ?? "node";
	const output = execFileSync(nodeBin, ["--input-type=module", "-e", code], {
		encoding: "utf8",
		windowsHide: true,
		env: {
			...process.env,
			PATH: [
				"C:\\Program Files\\nodejs",
				...(process.env.PATH ?? "").split(";"),
			].join(";"),
		},
	});
	expect(JSON.parse(output)).toMatchObject({
		valid: 2,
		total: 3,
		stale: [{ text: "DeadSymbol" }],
	});
});
