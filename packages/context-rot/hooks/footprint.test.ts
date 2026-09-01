/**
 * footprint hook 测试 — 覆盖 Claude Code 与 Cursor 双宿主的事件格式、
 * 确定性路径提取、路径越界与异常降级。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "footprint.mjs");

const tempRoots: string[] = [];

function makeRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "context-rot-hooks-"));
	tempRoots.push(root);
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
	return root;
}

/** 以子进程运行 hook，喂入事件 JSON，返回退出码。cwd 由调用方注入真实路径。 */
function runHook(
	root: string,
	eventJson: object,
	env: Record<string, string> = {},
) {
	return new Promise<number>((resolveExit) => {
		const child = spawn("node", [SCRIPT], {
			cwd: root,
			env: { ...process.env, CLAUDE_PROJECT_DIR: root, ...env },
			stdio: ["pipe", "ignore", "ignore"],
		});
		child.stdin.write(JSON.stringify({ cwd: root, ...eventJson }));
		child.stdin.end();
		child.on("exit", (code) => resolveExit(code ?? -1));
	});
}

/** 读足迹文件，返回解析后的记录数组；文件不存在时返回空数组。 */
function readFootprints(root: string): unknown[] {
	const file = join(root, ".context-rot", "footprints.jsonl");
	try {
		const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
		return lines.map((l) => JSON.parse(l));
	} catch {
		return [];
	}
}

function claudeEvent(
	tool: string,
	toolInput: Record<string, unknown>,
	extra: Record<string, unknown> = {},
) {
	return {
		session_id: "sess-1",
		prompt_id: "p-1",
		hook_event_name: "PostToolUse",
		tool_name: tool,
		tool_input: toolInput,
		tool_use_id: "toolu_1",
		...extra,
	};
}

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
	}
});

describe("Claude Code 事件格式", () => {
	test("Read → 读足迹", async () => {
		const root = makeRepo();
		const code = await runHook(
			root,
			claudeEvent("Read", { file_path: "src/a.ts", content_offset: 0 }),
		);
		expect(code).toBe(0);
		const [rec] = readFootprints(root) as Record<string, unknown>[];
		expect(rec.kind).toBe("read");
		expect(rec.path).toBe("src/a.ts");
		expect(rec.tool).toBe("Read");
		expect(rec.event).toBe("PostToolUse");
		expect(rec.session_id).toBe("sess-1");
		expect(rec.host).toBe("claude-code");
		expect(typeof rec.ts).toBe("string");
	});

	test("Write / Edit → 写足迹", async () => {
		const root = makeRepo();
		await runHook(
			root,
			claudeEvent("Write", { file_path: "src/b.ts", content: "x" }),
		);
		await runHook(
			root,
			claudeEvent("Edit", { file_path: "src/a.ts", old_string: "a" }),
		);
		const recs = readFootprints(root) as Record<string, unknown>[];
		expect(recs).toHaveLength(2);
		expect(recs.map((r) => r.kind)).toEqual(["write", "write"]);
		expect(recs.map((r) => r.path)).toEqual(["src/b.ts", "src/a.ts"]);
	});

	test("Grep / Glob → 目录级读足迹", async () => {
		const root = makeRepo();
		await runHook(root, claudeEvent("Grep", { pattern: "foo", path: "src" }));
		await runHook(root, claudeEvent("Glob", { pattern: "**/*.ts", path: "." }));
		const recs = readFootprints(root) as Record<string, unknown>[];
		expect(recs.map((r) => [r.kind, r.path])).toEqual([
			["read", "src"],
			["read", "."],
		]);
	});

	test("Grep 无 path 时记录仓库根（宽搜索）", async () => {
		const root = makeRepo();
		await runHook(root, claudeEvent("Grep", { pattern: "foo" }));
		const [rec] = readFootprints(root) as Record<string, unknown>[];
		expect(rec.kind).toBe("read");
		expect(rec.path).toBe(".");
	});

	test("Bash 不记录（命令不可确定）", async () => {
		const root = makeRepo();
		await runHook(root, claudeEvent("Bash", { command: "touch src/x.ts" }));
		expect(readFootprints(root)).toHaveLength(0);
	});
});

describe("Cursor 兼容（同一份配置）", () => {
	test("Cursor 把 Edit 映射为 Write，脚本按行为识别", async () => {
		const root = makeRepo();
		await runHook(root, claudeEvent("Write", { file_path: "src/c.ts" }), {
			CLAUDE_PROJECT_DIR: "",
			CURSOR_TRACE_ID: "trace-1",
		});
		const [rec] = readFootprints(root) as Record<string, unknown>[];
		expect(rec.kind).toBe("write");
		expect(rec.host).toBe("cursor");
	});

	test("Cursor 把 Bash 映射为 Shell，不采集", async () => {
		const root = makeRepo();
		await runHook(root, claudeEvent("Shell", { command: "git status" }), {
			CLAUDE_PROJECT_DIR: "",
			CURSOR_TRACE_ID: "trace-1",
		});
		expect(readFootprints(root)).toHaveLength(0);
	});

	test("Cursor 顶层平铺 file_path 变体", async () => {
		const root = makeRepo();
		await runHook(
			root,
			{
				hook_event_name: "PostToolUse",
				tool_name: "Read",
				file_path: "src/a.ts",
			},
			{ CLAUDE_PROJECT_DIR: "", CURSOR_TRACE_ID: "trace-1" },
		);
		const [rec] = readFootprints(root) as Record<string, unknown>[];
		expect(rec.kind).toBe("read");
		expect(rec.path).toBe("src/a.ts");
		expect(rec.host).toBe("cursor");
	});

	test("无 CLAUDE_PROJECT_DIR 时回退事件 cwd", async () => {
		const root = makeRepo();
		await runHook(root, claudeEvent("Read", { file_path: "src/a.ts" }), {
			CLAUDE_PROJECT_DIR: "",
		});
		const [rec] = readFootprints(root) as Record<string, unknown>[];
		expect(rec.path).toBe("src/a.ts");
	});
});

describe("健壮性", () => {
	test("非法 JSON 输入不崩溃且退出 0", async () => {
		const root = makeRepo();
		const code = await new Promise<number>((resolveExit) => {
			const child = spawn("node", [SCRIPT], {
				cwd: root,
				env: { ...process.env, CLAUDE_PROJECT_DIR: root },
				stdio: ["pipe", "ignore", "ignore"],
			});
			child.stdin.write("not json {{{");
			child.stdin.end();
			child.on("exit", (c) => resolveExit(c ?? -1));
		});
		expect(code).toBe(0);
		expect(readFootprints(root)).toHaveLength(0);
	});

	test("空输入退出 0 且不写文件", async () => {
		const root = makeRepo();
		const code = await runHook(root, {});
		expect(code).toBe(0);
		expect(readFootprints(root)).toHaveLength(0);
	});

	test("路径越出仓库根保留绝对路径（不误写相对盘符）", async () => {
		const root = makeRepo();
		await runHook(root, claudeEvent("Read", { file_path: "../../etc/passwd" }));
		const [rec] = readFootprints(root) as Record<string, unknown>[];
		expect(String(rec.path)).toContain("etc");
		expect(String(rec.path)).not.toContain("..");
	});

	test("多次事件按序追加，JSONL 每行一条", async () => {
		const root = makeRepo();
		for (let i = 0; i < 3; i++) {
			await runHook(root, claudeEvent("Read", { file_path: `src/a.ts` }));
		}
		const recs = readFootprints(root);
		expect(recs).toHaveLength(3);
	});
});
