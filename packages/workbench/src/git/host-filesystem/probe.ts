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
