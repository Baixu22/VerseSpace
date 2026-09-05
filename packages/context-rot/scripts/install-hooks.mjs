#!/usr/bin/env node
/**
 * context-rot hooks 安装器 — 一条命令把足迹采集与封印点接入任意仓库。
 *
 * 用法：
 *   node scripts/install-hooks.mjs [仓库目录]              安装（默认当前目录）
 *   node scripts/install-hooks.mjs [仓库目录] --uninstall   卸载
 *   node scripts/install-hooks.mjs --help
 *
 * 安装做的事：
 *   1. 复制 hooks/footprint.mjs → <仓库>/.claude/hooks/footprint.mjs
 *   2. 把两个 agent hook 合并进 <仓库>/.claude/settings.json（保留已有配置）
 *   3. 装三个 git hook（post-merge / post-checkout / post-rewrite），
 *      把 merge / rebase / checkout 带来的变更登记给 git 写者（TF-0150）
 *   4. 提示把 .context-rot/ 加入 .gitignore
 *
 * 同一份 .claude/settings.json 在 Claude Code 与 Cursor（开启 Third-party
 * skills 后）都会加载，因此一份配置两个宿主都能生效。
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

/**
 * The wiring table. Adding a hook here is the only edit needed to ship it:
 * install, uninstall, and the help text all read from this one place, so the
 * matcher and command cannot drift between them. Keep it in step with
 * plugin/hooks/hooks.json, which is the same wiring in plugin form.
 */
const HOOKS = [
	{
		id: "footprint",
		event: "PostToolUse",
		matcher: "Read|Write|Edit|Grep|Glob",
		command: "node .claude/hooks/footprint.mjs",
		timeout: 10,
		script: "footprint.mjs",
		note: "读写足迹 → .context-rot/footprints.jsonl（只观测，永不阻塞）",
	},
	{
		id: "seal",
		event: "PreToolUse",
		matcher: "Write|Edit|MultiEdit|NotebookEdit",
		command: "workbench premises seal",
		timeout: 10,
		note:
			"封印点（TF-0134）：写入落在已失效前提上时，按 workbench.yaml 的 " +
			"seal.mode 处理（block|warn|off，默认 block）。仓库没有 .workbench/ " +
			"或 workbench 不在 PATH 上时静默放行，不阻断写入。",
	},
];

/**
 * git hooks (TF-0150). git is a writer like any other: a `git pull` changes
 * files under people's feet, and until git claims those writes itself the
 * watcher attributes them to whoever happens to be at the editor.
 *
 * Every script ends in `exit 0` no matter what. A footprint recorder that can
 * fail a merge would be uninstalled by hand within a day, and rightly so.
 */
const MARKER = "context-rot:workbench-footprint";
const RECORD = "workbench sessions record --quiet";

const GIT_HOOKS = [
	{
		name: "post-merge",
		note: "merge / pull 带来的变更登记给 git 写者",
		body: `git diff-tree -r --name-only --no-commit-id ORIG_HEAD HEAD 2>/dev/null |
  ${RECORD} --activity post-merge >/dev/null 2>&1
`,
	},
	{
		name: "post-checkout",
		note: "切分支带来的变更登记给 git 写者（只在切分支时，不在建文件时）",
		body: `# $3 = 1 只在切分支时为真；checkout 单个文件不算写者活动
[ "$3" = "1" ] || exit 0
git diff-tree -r --name-only --no-commit-id "$1" "$2" 2>/dev/null |
  ${RECORD} --activity post-checkout >/dev/null 2>&1
`,
	},
	{
		name: "post-rewrite",
		note: "rebase / amend 重写历史后的变更登记给 git 写者",
		body: `# stdin 是 old-sha new-sha 成对的行
while read -r old new _rest; do
  git diff-tree -r --name-only --no-commit-id "$old" "$new" 2>/dev/null
done | sort -u | ${RECORD} --activity "post-rewrite-\${1:-amend}" >/dev/null 2>&1
`,
	},
];

function gitHookScript(hook) {
	return `#!/bin/sh
# ${MARKER} — ${hook.note}
# 由 context-rot 安装器写入；只观测，绝不让 git 操作失败。
${hook.body}exit 0
`;
}

function help() {
	console.log(`context-rot hooks 安装器 — 一条命令接入足迹采集与封印点

用法：
  node scripts/install-hooks.mjs [仓库目录]           安装（默认当前目录）
  node scripts/install-hooks.mjs [仓库目录] --uninstall
  node scripts/install-hooks.mjs --help

安装的 hook：`);
	for (const hook of HOOKS) {
		console.log(`  ${hook.event}（matcher=${hook.matcher}）`);
		console.log(`    ${hook.command}`);
		console.log(`    ${hook.note}`);
	}
	console.log(`
git hook（写者中立：git 也是写者）：`);
	for (const hook of GIT_HOOKS) {
		console.log(`  .git/hooks/${hook.name} — ${hook.note}`);
	}
	console.log(`
同一份 .claude/settings.json 在 Claude Code 与 Cursor 中都会生效。
卸载：移除上述 matcher 的配置条目，删除随装脚本，并摘掉带本安装器标记的 git hook。`);
}

function sourceScript(name) {
	return resolve(HERE, `../hooks/${name}`);
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

/** Merge one hook into the settings tree, replacing only its own matcher. */
function mergeHook(settings, hook) {
	const out = settings ?? {};
	if (!out.hooks) out.hooks = {};
	const groups = out.hooks;
	if (!Array.isArray(groups[hook.event])) groups[hook.event] = [];
	const list = groups[hook.event];
	const entry = {
		matcher: hook.matcher,
		hooks: [{ type: "command", command: hook.command, timeout: hook.timeout }],
	};
	const index = list.findIndex((group) => group.matcher === hook.matcher);
	if (index >= 0) list[index] = { ...list[index], ...entry };
	else list.push(entry);
	return out;
}

/** Remove one hook, leaving any other entry the user owns untouched. */
function removeHook(settings, hook) {
	const groups = settings.hooks;
	if (!groups || !Array.isArray(groups[hook.event])) return;
	groups[hook.event] = groups[hook.event].filter(
		(group) => group.matcher !== hook.matcher,
	);
	if (groups[hook.event].length === 0) delete groups[hook.event];
	if (Object.keys(groups).length === 0) delete settings.hooks;
}

/**
 * Write the three git hooks. An existing hook that is not ours is left exactly
 * as it is and reported — silently overwriting someone's pre-existing
 * post-checkout would be a far worse bug than not collecting a footprint.
 */
function installGitHooks(target) {
	const dir = join(target, ".git", "hooks");
	if (!existsSync(join(target, ".git"))) {
		return { installed: [], skipped: [], absent: true };
	}
	mkdirSync(dir, { recursive: true });
	const installed = [];
	const skipped = [];
	for (const hook of GIT_HOOKS) {
		const file = join(dir, hook.name);
		if (existsSync(file) && !readFileSync(file, "utf8").includes(MARKER)) {
			skipped.push(hook.name);
			continue;
		}
		writeFileSync(file, gitHookScript(hook), { mode: 0o755 });
		installed.push(hook.name);
	}
	return { installed, skipped, absent: false };
}

function removeGitHooks(target) {
	const dir = join(target, ".git", "hooks");
	const removed = [];
	for (const hook of GIT_HOOKS) {
		const file = join(dir, hook.name);
		if (!existsSync(file)) continue;
		// Only ours: a hook the user wrote by hand keeps its place.
		if (!readFileSync(file, "utf8").includes(MARKER)) continue;
		rmSync(file);
		removed.push(hook.name);
	}
	return removed;
}

function install(target) {
	const hooksDir = join(target, ".claude", "hooks");
	mkdirSync(hooksDir, { recursive: true });
	const { file, data } = loadSettings(target);
	const merged = JSON.parse(JSON.stringify(data ?? {}));
	for (const hook of HOOKS) {
		if (hook.script) {
			copyFileSync(sourceScript(hook.script), join(hooksDir, hook.script));
		}
		mergeHook(merged, hook);
	}
	writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
	const git = installGitHooks(target);

	console.log(`✔ 已安装 context-rot hooks：${target}`);
	for (const hook of HOOKS) {
		console.log(`  - ${hook.event} matcher=${hook.matcher} → ${hook.command}`);
		console.log(`    ${hook.note}`);
	}
	console.log("  - 配置：.claude/settings.json（已保留其他 hook 条目）");
	if (git.absent) {
		console.log("  - git hook：跳过（这里不是 git 仓库）");
	} else {
		if (git.installed.length > 0) {
			console.log(
				`  - git hook：${git.installed.join(" / ")}（写者中立：git 也登记自己的写入）`,
			);
		}
		for (const name of git.skipped) {
			console.log(
				`  ⚠ .git/hooks/${name} 已存在且不是本安装器写的，已保留原文件。` +
					`需要的话把 \`${RECORD} --activity ${name}\` 接进去。`,
			);
		}
	}

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
	for (const hook of HOOKS) {
		removeHook(data, hook);
		if (!hook.script) continue;
		const script = join(target, ".claude", "hooks", hook.script);
		if (existsSync(script)) rmSync(script);
	}
	writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
	const removed = removeGitHooks(target);
	console.log(`✔ 已移除 context-rot hooks：${target}`);
	if (removed.length > 0) {
		console.log(`  - git hook：${removed.join(" / ")}`);
	}
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
