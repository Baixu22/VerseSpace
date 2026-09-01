import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatHuman, formatJson, main } from "./cli.ts";
import { collectDocFiles, scanRepo } from "./scan.ts";

const tempRoots: string[] = [];

function makeFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "context-rot-cli-"));
	tempRoots.push(root);
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(
		join(root, "src", "live.ts"),
		"export function LiveComponent() {}\nexport const helperFn = 1;\n",
	);
	writeFileSync(
		join(root, "AGENTS.md"),
		[
			"# Guide",
			"entry is `src/live.ts`",
			"use `LiveComponent` and `helperFn`",
			"see `src/dead.ts` and `DeadSymbol` and `@nope/gone`",
		].join("\n"),
	);
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo" }));
	return root;
}

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
	}
});

describe("collectDocFiles", () => {
	test("root 传相对路径（.）时 .cursor/rules 也能算出正确相对路径", () => {
		const root = mkdtempSync(join(tmpdir(), "context-rot-docs-"));
		tempRoots.push(root);
		mkdirSync(join(root, ".cursor", "rules"), { recursive: true });
		writeFileSync(join(root, ".cursor", "rules", "x.md"), "doc\n");
		writeFileSync(join(root, "CLAUDE.md"), "doc\n");
		const cwd = process.cwd();
		try {
			process.chdir(root);
			const docs = collectDocFiles(".").sort();
			expect(docs).toEqual([".cursor/rules/x.md", "CLAUDE.md"].sort());
		} finally {
			process.chdir(cwd);
		}
	});
});

describe("scanRepo", () => {
	test("汇总有效与失效断言", async () => {
		const root = makeFixture();
		const result = await scanRepo(root);
		expect(result.docs).toEqual(["AGENTS.md"]);
		expect(result.total).toBe(6);
		expect(result.valid).toBe(3);
		expect(result.stale).toHaveLength(3);
		const staleTexts = result.stale.map((r) => r.text).sort();
		expect(staleTexts).toEqual(["@nope/gone", "DeadSymbol", "src/dead.ts"]);
	});
});

describe("formatHuman", () => {
	test("标题行给出『N 条中 M 条已失效』口径", async () => {
		const root = makeFixture();
		const result = await scanRepo(root);
		const out = formatHuman(result);
		expect(out).toContain("架构断言：6 条");
		expect(out).toContain("已失效 3 条");
		expect(out).toContain("AGENTS.md:4");
		expect(out).toContain("`src/dead.ts`");
	});
});

describe("formatJson", () => {
	test("JSON 输出可解析", async () => {
		const root = makeFixture();
		const result = await scanRepo(root);
		const parsed = JSON.parse(formatJson(result)) as {
			totalAssertions: number;
			valid: number;
			stale: unknown[];
		};
		expect(parsed.totalAssertions).toBe(6);
		expect(parsed.valid).toBe(3);
		expect(parsed.stale).toHaveLength(3);
	});
});

describe("main", () => {
	test("无失效时退出码 0", async () => {
		const root = mkdtempSync(join(tmpdir(), "context-rot-clean-"));
		tempRoots.push(root);
		writeFileSync(join(root, "CLAUDE.md"), "ok `package.json`\n");
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo" }));
		const code = await main([root]);
		expect(code).toBe(0);
	});

	test("有失效时退出码 1", async () => {
		const root = makeFixture();
		const code = await main([root]);
		expect(code).toBe(1);
	});

	test("没有指引文件时退出码 2", async () => {
		const root = mkdtempSync(join(tmpdir(), "context-rot-empty-"));
		tempRoots.push(root);
		const code = await main([root]);
		expect(code).toBe(2);
	});

	test("--help 退出码 0", async () => {
		expect(await main(["--help"])).toBe(0);
	});
});

describe("install-hooks 子命令", () => {
	test("安装到指定仓库：复制脚本 + 合并配置", async () => {
		const root = mkdtempSync(join(tmpdir(), "context-rot-install-"));
		tempRoots.push(root);
		const code = await main(["install-hooks", root]);
		expect(code).toBe(0);
		expect(existsSync(join(root, ".claude", "hooks", "footprint.mjs"))).toBe(
			true,
		);
		const settings = JSON.parse(
			readFileSync(join(root, ".claude", "settings.json"), "utf8"),
		) as { hooks: { PostToolUse: Array<{ matcher?: string }> } };
		expect(settings.hooks.PostToolUse[0]?.matcher).toBe(
			"Read|Write|Edit|Grep|Glob",
		);
	});

	test("卸载移除脚本，配置还原为空对象", async () => {
		const root = mkdtempSync(join(tmpdir(), "context-rot-uninstall-"));
		tempRoots.push(root);
		await main(["install-hooks", root]);
		const code = await main(["install-hooks", root, "--uninstall"]);
		expect(code).toBe(0);
		expect(existsSync(join(root, ".claude", "hooks", "footprint.mjs"))).toBe(
			false,
		);
		const settings = JSON.parse(
			readFileSync(join(root, ".claude", "settings.json"), "utf8"),
		) as Record<string, unknown>;
		expect(settings.hooks).toBeUndefined();
	});

	test("--help 透传给安装器并退出 0", async () => {
		expect(await main(["install-hooks", "--help"])).toBe(0);
	});
});
