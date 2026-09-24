#!/usr/bin/env node
/**
 * context-rot footprint hook — 采集 agent 对仓库的确定性读写足迹。
 *
 * 被 Claude Code 的 PostToolUse hook 调用（Cursor 开启 Third-party skills 后
 * 加载同一份 .claude/settings.json，同样触发本脚本）。stdin 收到事件 JSON，
 * 把可确定的读写路径追加一行到 <root>/.context-rot/footprints.jsonl。
 *
 * 设计约束：
 *  - 只观测，永不阻塞：任何错误都静默降级，退出码恒为 0。
 *  - 只记确定性：路径来自工具参数（Read/Write/Edit 的 file_path、
 *    Grep/Glob 的 path），Bash/Shell 的命令不猜测。
 *  - 双宿主兼容：Cursor 会把 Edit 映射为 Write、Bash 映射为 Shell，
 *    脚本按工具行为分类而非枚举宿主私有名字。
 *
 * 用法（由配置注入，无需人工调用）：
 *   node .claude/hooks/footprint.mjs
 * 调试：
 *   CONTEXT_ROT_DEBUG=1 node .claude/hooks/footprint.mjs < event.json
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const DEBUG = process.env.CONTEXT_ROT_DEBUG === "1";

/** 读工具（确定性读） */
const READ_TOOLS = new Set([
	"read",
	"grep",
	"glob",
	"webfetch",
	"notebookread",
]);
/** 写工具（确定性写） */
const WRITE_TOOLS = new Set([
	"write",
	"edit",
	"multiedit",
	"notebookedit",
	"notebookwrite",
]);

/**
 * 解析仓库根：宿主项目目录环境变量 > 事件 cwd > 进程 cwd。
 * Claude Code 的 CLAUDE_PROJECT_DIR 在 worktree 内保持不变，优先用它。
 */
function resolveRoot(ev) {
	if (process.env.CLAUDE_PROJECT_DIR)
		return resolve(process.env.CLAUDE_PROJECT_DIR);
	if (process.env.CURSOR_PROJECT_DIR)
		return resolve(process.env.CURSOR_PROJECT_DIR);
	if (typeof ev?.cwd === "string" && ev.cwd) return resolve(ev.cwd);
	return process.cwd();
}

/** 识别宿主（仅用于记录，不影响行为） */
function detectHost() {
	if (process.env.CLAUDE_PROJECT_DIR) return "claude-code";
	if (process.env.CURSOR_PROJECT_DIR || process.env.CURSOR_TRACE_ID)
		return "cursor";
	return "unknown";
}

/** 把绝对路径压成相对仓库根的 POSIX 形式；越出根则保留绝对路径。 */
function toRel(root, abs) {
	const rel = relative(root, abs);
	if (!rel) return ".";
	if (rel.startsWith("..")) return abs.split(sep).join("/");
	return rel.split(sep).join("/");
}

/** 从事件里提取确定性路径；拿不到返回 ""。 */
function extractPath(ev, toolInput) {
	const fp =
		toolInput.file_path ||
		toolInput.filePath ||
		(typeof ev.file_path === "string" ? ev.file_path : "");
	if (fp) return fp;
	// Grep / Glob 的 path 参数是搜索目录
	const p = toolInput.path || toolInput.paths;
	if (typeof p === "string" && p) return p;
	return "";
}

/** 按工具名分类读写；无法确定返回 ""。 */
function classifyKind(toolName) {
	const t = String(toolName || "").toLowerCase();
	if (READ_TOOLS.has(t)) return "read";
	if (WRITE_TOOLS.has(t)) return "write";
	return "";
}

function appendRecord(root, rec) {
	const dir = resolve(root, ".context-rot");
	try {
		mkdirSync(dir, { recursive: true });
	} catch (err) {
		if (DEBUG)
			console.error(`context-rot: mkdir ${dir} failed: ${err.message}`);
		return;
	}
	try {
		appendFileSync(
			resolve(dir, "footprints.jsonl"),
			`${JSON.stringify(rec)}\n`,
		);
	} catch (err) {
		if (DEBUG) console.error(`context-rot: append failed: ${err.message}`);
	}
}

function main() {
	let input = "";
	try {
		input = readFileSync(0, "utf8");
	} catch {
		return;
	}
	if (!input.trim()) return;

	let ev;
	try {
		ev = JSON.parse(input);
	} catch {
		if (DEBUG) console.error("context-rot: 输入不是合法 JSON，忽略");
		return;
	}
	if (!ev || typeof ev !== "object") return;

	const toolName = ev.tool_name || ev.tool || "";
	const toolInput =
		ev.tool_input && typeof ev.tool_input === "object" ? ev.tool_input : {};
	const event =
		ev.hook_event_name || ev.event_name || ev.hook_event || "PostToolUse";

	const kind = classifyKind(toolName);
	if (!kind) return; // Bash/Shell/其他：不确定，不记

	const root = resolveRoot(ev);
	// Grep/Glob 无显式 path 时视为对仓库根的宽搜索
	const tl = String(toolName).toLowerCase();
	const isDirSearch = tl === "grep" || tl === "glob";
	const target = extractPath(ev, toolInput) || (isDirSearch ? "." : "");
	if (!target) return; // 没有确定性路径，不记

	const abs = resolve(root, target);

	appendRecord(root, {
		ts: new Date().toISOString(),
		session_id: ev.session_id || "",
		event,
		tool: toolName,
		kind,
		path: toRel(root, abs),
		host: detectHost(),
		cwd: ev.cwd || "",
	});
}

try {
	main();
} catch (err) {
	// 观测者永不阻塞主流程
	if (DEBUG) console.error(`context-rot: hook 异常 ${err?.message ?? err}`);
}
