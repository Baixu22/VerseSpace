import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 宿主文件系统探针与执行闸门。
 *
 * 背景：部分宿主（WorkBuddy 5.5.x 捆绑 sandbox 的文件操作层）会让
 * 「删除非空目录」返回成功。git 的 `dir.c::remove_path` 与
 * `refs/files-backend.c::try_remove_empty_parents` 依赖「非空目录删不掉」
 * 这一 Windows 语义做空父目录清理；语义被改写后，清理变成连带删除：
 * 兄弟文件消失、ref 消失，而 git 自己退出 0。
 *
 * 证据与剩余边界见 `docs/git-crash-followup-2026-09-21.md`（TF-0173）。
 * 该文档的实测结论是：**进程加载了 tsbx.dll 并不足以复现**——判据是
 * 「非空目录能不能被删掉」，本模块只测这一点，不做模块归因。
 */

export type HostFilesystemVerdict = "clean" | "unsafe" | "indeterminate";

export interface HostFilesystemProbe {
	verdict: HostFilesystemVerdict;
	/** rmdir 对非空目录返回成功（Windows 语义应为失败）。 */
	nonEmptyDirectoryRemoved: boolean;
	/** 放在非空目录里的哨兵文件活了下来。 */
	sentinelSurvived: boolean;
	/** rmdir 抛错时的 errno 代码，供诊断。 */
	errorCode?: string;
}

/** 关闭闸门（承担风险）；force-* 仅用于测试构造判定。 */
export const HOST_GUARD_ENV = "WORKBENCH_GIT_HOST_GUARD";

let cachedProbe: HostFilesystemProbe | undefined;

function forcedVerdict(): HostFilesystemVerdict | undefined {
	const mode = (process.env[HOST_GUARD_ENV] ?? "").trim().toLowerCase();
	if (mode === "force-unsafe") return "unsafe";
	if (mode === "force-clean") return "clean";
	return undefined;
}

/** 本环境是否禁止运行会改写工作树/ref 的 git 命令。 */
export function hostGuardDisabled(): boolean {
	return (process.env[HOST_GUARD_ENV] ?? "").trim().toLowerCase() === "off";
}

/**
 * 探测宿主是否保留了「非空目录不可删除」的语义。
 *
 * 判定只看文件副作用，不看错误码：只要哨兵文件还在，就说明删除被拒。
 * 结果按进程缓存——宿主行为在进程生命周期内不会变。
 */
export function probeHostFilesystem(): HostFilesystemProbe {
	const forced = forcedVerdict();
	if (forced) {
		return {
			verdict: forced,
			nonEmptyDirectoryRemoved: forced === "unsafe",
			sentinelSurvived: forced !== "unsafe",
		};
	}
	cachedProbe ??= runHostFilesystemProbe();
	return cachedProbe;
}

export function resetHostFilesystemProbe(): void {
	cachedProbe = undefined;
}

function runHostFilesystemProbe(): HostFilesystemProbe {
	let root: string | undefined;
	let errorCode: string | undefined;
	try {
		root = mkdtempSync(join(tmpdir(), "workbench-host-fs-"));
		const nonEmpty = join(root, "nonempty");
		mkdirSync(nonEmpty);
		const sentinel = join(nonEmpty, "keep.txt");
		writeFileSync(sentinel, "must survive", "utf8");

		let removed = false;
		try {
			// 健康宿主在这里必须失败。
			rmdirSync(nonEmpty);
			removed = true;
		} catch (error) {
			errorCode = (error as NodeJS.ErrnoException).code;
		}
		const sentinelSurvived = existsSync(sentinel);
		if (removed && !sentinelSurvived) {
			return {
				verdict: "unsafe",
				nonEmptyDirectoryRemoved: true,
				sentinelSurvived: false,
			};
		}
		if (sentinelSurvived) {
			return {
				verdict: "clean",
				nonEmptyDirectoryRemoved: removed,
				sentinelSurvived: true,
				errorCode,
			};
		}
		return {
			verdict: "indeterminate",
			nonEmptyDirectoryRemoved: removed,
			sentinelSurvived: false,
			errorCode,
		};
	} catch (error) {
		return {
			verdict: "indeterminate",
			nonEmptyDirectoryRemoved: false,
			sentinelSurvived: false,
			errorCode: (error as NodeJS.ErrnoException).code,
		};
	} finally {
		if (root) removeProbeRoot(root);
	}
}

function removeProbeRoot(root: string): void {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			rmSync(root, { recursive: true, force: true });
			return;
		} catch {
			// 扫描器可能还握着句柄，稍后重试；探针自身绝不让清理失败冒泡。
		}
	}
}

/** 纯只读动词：任何参数组合都不写工作树、不写 ref。 */
const READ_ONLY_VERBS = new Set([
	"annotate",
	"blame",
	"cat-file",
	"check-attr",
	"check-ignore",
	"check-mailmap",
	"check-ref-format",
	"count-objects",
	"describe",
	"diff",
	"diff-files",
	"diff-index",
	"diff-tree",
	"for-each-ref",
	"get-tar-commit-id",
	"grep",
	"hash-object",
	"interpret-trailers",
	"log",
	"ls-files",
	"ls-remote",
	"ls-tree",
	"merge-base",
	"merge-tree",
	"name-rev",
	"rev-list",
	"rev-parse",
	"shortlog",
	"show",
	"show-index",
	"show-ref",
	"status",
	"var",
	"verify-commit",
	"verify-pack",
	"verify-tag",
	"version",
	"whatchanged",
]);

/**
 * 条件只读动词：裸调用（或只读子命令/只读选项）是列出。
 * 判定不出来时一律按可写处理——闸门宁可多拦，不可放过连带删除。
 */
const CONDITIONAL_VERBS: Record<
	string,
	{
		bare?: boolean;
		readOnlyFlags?: ReadonlySet<string>;
		subcommands?: ReadonlySet<string>;
	}
> = {
	branch: {
		bare: true,
		readOnlyFlags: new Set([
			"-a",
			"-r",
			"-v",
			"-vv",
			"-l",
			"--list",
			"--show-current",
			"--contains",
			"--no-contains",
			"--merged",
			"--no-merged",
			"--points-at",
			"--format",
			"--sort",
			"--column",
			"--no-column",
			"--color",
			"--no-color",
			"--abbrev",
		]),
	},
	config: {
		readOnlyFlags: new Set([
			"--get",
			"--get-all",
			"--get-regexp",
			"--get-urlmatch",
			"--list",
			"-l",
			"--show-origin",
			"--show-scope",
			"--name-only",
			"--type",
		]),
	},
	notes: { subcommands: new Set(["list"]) },
	remote: { bare: true, readOnlyFlags: new Set(["-v", "--verbose"]) },
	stash: { subcommands: new Set(["list", "show"]) },
	submodule: { subcommands: new Set(["status", "summary"]) },
	tag: {
		bare: true,
		readOnlyFlags: new Set([
			"-l",
			"--list",
			"-n",
			"-i",
			"--ignore-case",
			"--contains",
			"--no-contains",
			"--merged",
			"--no-merged",
			"--points-at",
			"--format",
			"--sort",
			"--column",
			"--no-column",
			"--color",
			"--no-color",
		]),
	},
	worktree: { subcommands: new Set(["list"]) },
};

/** 动词之前、带独立取值的全局选项。 */
const GLOBAL_OPTION_WITH_VALUE = new Set([
	"-c",
	"-C",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--exec-path",
	"--config-env",
]);

/** 动词之前、以 `--x=` 形式带值的全局选项。 */
const GLOBAL_OPTION_PREFIXES = [
	"--git-dir=",
	"--work-tree=",
	"--namespace=",
	"--exec-path=",
	"--config-env=",
	"--attr-source=",
	"--list-cmds=",
];

/** 动词之前、不带值的全局旗标。 */
const GLOBAL_FLAGS = new Set([
	"--bare",
	"--glob-pathspecs",
	"--icase-pathspecs",
	"--literal-pathspecs",
	"--no-optional-locks",
	"--no-pager",
	"--no-replace-objects",
	"--noglob-pathspecs",
	"--paginate",
	"-p",
	"-P",
]);

/** 从 git 参数里取出动词与紧随其后的子命令/首个选项。 */
function parseGitCommand(args: string[]): {
	verb?: string;
	rest: string[];
} {
	let index = 0;
	while (index < args.length) {
		const token = args[index] as string;
		if (GLOBAL_OPTION_WITH_VALUE.has(token)) {
			index += 2;
			continue;
		}
		if (GLOBAL_OPTION_PREFIXES.some((prefix) => token.startsWith(prefix))) {
			index += 1;
			continue;
		}
		if (GLOBAL_FLAGS.has(token)) {
			index += 1;
			continue;
		}
		break;
	}
	const verb = args[index];
	if (verb === undefined) return { rest: [] };
	return { verb, rest: args.slice(index + 1) };
}

/** 这条 git 命令是否可证明为只读。 */
export function isReadOnlyGitCommand(args: string[]): boolean {
	const { verb, rest } = parseGitCommand(args);
	if (verb === undefined) return false;
	if (READ_ONLY_VERBS.has(verb)) return true;

	const conditional = CONDITIONAL_VERBS[verb];
	if (!conditional) return false;
	if (rest.length === 0) return conditional.bare === true;
	const first = rest[0] as string;
	if (conditional.readOnlyFlags?.has(first)) return true;
	if (first.startsWith("-")) return false;
	return conditional.subcommands?.has(first) === true;
}

/**
 * 宿主文件操作层已被证实会连带删除时，返回拒绝理由；否则 undefined。
 * 只读命令不受影响——诊断与汇报仍然可用。
 */
export function hostFilesystemGuardReason(args: string[]): string | undefined {
	if (hostGuardDisabled()) return undefined;
	if (isReadOnlyGitCommand(args)) return undefined;
	if (probeHostFilesystem().verdict !== "unsafe") return undefined;
	return [
		`拒绝执行 \`git ${args.join(" ")}\`：本宿主的文件系统探针显示，删除非空目录会返回成功。`,
		"git 的空父目录清理依赖该语义，会把无关文件与 ref 一起删掉，而 git 自身退出 0（TF-0173）。",
		"请在原生宿主中重跑；确实要在此环境承担风险时设 WORKBENCH_GIT_HOST_GUARD=off。",
	].join(" ");
}
