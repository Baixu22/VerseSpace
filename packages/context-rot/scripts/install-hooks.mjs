#!/usr/bin/env node
/**
 * context-rot hooks 安装器 — 一条命令把足迹采集接入任意仓库。
 *
 * 用法：
 *   node scripts/install-hooks.mjs [仓库目录]     安装（默认当前目录）
 *   node scripts/install-hooks.mjs [仓库目录] --uninstall   卸载
 *   node scripts/install-hooks.mjs --help
 *
 * 安装做的事：
 *   1. 复制 hooks/footprint.mjs → <仓库>/.claude/hooks/footprint.mjs
 *   2. 合并 PostToolUse hook 进 <仓库>/.claude/settings.json（保留已有配置）
 *   3. 提示把 .context-rot/ 加入 .gitignore
 *
 * 同一份 .claude/settings.json 在 Claude Code 与 Cursor（开启 Third-party
 * skills 后）都会加载，因此一份配置两个宿主都能采集足迹。
 */

import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));

const TARGET_MATCHER = "Read|Write|Edit|Grep|Glob";
const SCRIPT_NAME = "footprint.mjs";
const COMMAND = "node .claude/hooks/footprint.mjs";

function help() {
	console.log(`context-rot hooks 安装器 — 一条命令接入 agent 读写足迹采集

用法：
  node scripts/install-hooks.mjs [仓库目录]           安装（默认当前目录）
  node scripts/install-hooks.mjs [仓库目录] --uninstall
  node scripts/install-hooks.mjs --help

安装：复制 footprint.mjs 到 .claude/hooks/，并把 PostToolUse hook
（matcher=Read|Write|Edit|Grep|Glob）合并进 .claude/settings.json。
同一份配置在 Claude Code 与 Cursor 中都会生效。
卸载：移除该 matcher 的配置条目并删除脚本。`);
}

function sourceScript() {
	return resolve(HERE, "../hooks/footprint.mjs");
}

function loadSettings(dir) {
	const file = join(dir, ".claude", "settings.json");
	if (!existsSync(file)) return { file, data: {} };
	try {
		return { file, data: JSON.parse(readFileSync(file, "utf8")) };
	} catch (err) {
		console.error(
			`✘ ${file} 不是合法 JSON（${err.message}）。请先手工修复再安装。`,
		);
		process.exit(1);
	}
}

function mergeHooks(existing, matcher, hookEntry) {
	const out = JSON.parse(JSON.stringify(existing ?? {}));
	if (!out.hooks) out.hooks = {};
	const hooks = out.hooks;
	if (!Array.isArray(hooks.PostToolUse)) hooks.PostToolUse = [];
	const list = hooks.PostToolUse;
	const idx = list.findIndex((g) => g.matcher === matcher);
	if (idx >= 0) {
		list[idx] = { ...list[idx], ...hookEntry };
	} else {
		list.push(hookEntry);
	}
	return out;
}

function install(target) {
	const claudeDir = join(target, ".claude", "hooks");
	mkdirSync(claudeDir, { recursive: true });
	copyFileSync(sourceScript(), join(claudeDir, SCRIPT_NAME));

	const { file, data } = loadSettings(target);
	const hookEntry = {
		matcher: TARGET_MATCHER,
		hooks: [{ type: "command", command: COMMAND, timeout: 10 }],
	};
	const merged = mergeHooks(data, TARGET_MATCHER, hookEntry);
	writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);

	console.log(`✔ 已安装 footprint hook：${target}`);
	console.log(`  - 脚本：.claude/hooks/${SCRIPT_NAME}`);
	console.log(
		`  - 配置：.claude/settings.json（PostToolUse matcher=${TARGET_MATCHER}）`,
	);
	console.log(`  - 数据：读写足迹将追加到 .context-rot/footprints.jsonl`);

	const gi = join(target, ".gitignore");
	const hasIgnore =
		existsSync(gi) && readFileSync(gi, "utf8").includes(".context-rot/");
	if (!hasIgnore) {
		console.log(
			"  ⚠ 建议把 .context-rot/ 加入 .gitignore（足迹是本地数据，不宜提交）。",
		);
	}
}

function uninstall(target) {
	const { file, data } = loadSettings(target);
	const hooks = data.hooks;
	if (hooks && Array.isArray(hooks.PostToolUse)) {
		hooks.PostToolUse = hooks.PostToolUse.filter(
			(g) => g.matcher !== TARGET_MATCHER,
		);
		if (hooks.PostToolUse.length === 0) delete hooks.PostToolUse;
		if (Object.keys(hooks).length === 0) delete data.hooks;
		writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
	}
	const script = join(target, ".claude", "hooks", SCRIPT_NAME);
	if (existsSync(script)) rmSync(script);
	console.log(`✔ 已移除 footprint hook：${target}`);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
	help();
	process.exit(0);
}
const target = resolve(args.find((a) => !a.startsWith("--")) ?? process.cwd());
if (!existsSync(target)) {
	console.error(`✘ 目标目录不存在：${target}`);
	process.exit(1);
}
if (args.includes("--uninstall")) uninstall(target);
else install(target);
