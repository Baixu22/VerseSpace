import { join, resolve } from "node:path";
import type { Blackboard } from "../../blackboard";
import { pathExists } from "../../fs/atomic";
import type { WorkbenchConfig } from "../../types/config";
import type { DoctorIssue } from "../types";

export function checkAutoCap(
	config: WorkbenchConfig,
	issues: DoctorIssue[],
): void {
	// ── config sanity: auto policy needs a positive concurrency cap ──
	if (config.scheduler.policy === "auto") {
		const cap = config.scheduler.autoConstraints?.maxConcurrentWorkspots;
		if (cap === undefined || cap < 1) {
			issues.push({
				check: "auto_without_cap",
				severity: "error",
				message:
					"scheduler.policy=auto 需要配置 scheduler.autoConstraints.maxConcurrentWorkspots ≥ 1",
			});
		}
	}
}

export async function checkProtectionConfig(
	bb: Blackboard,
	config: WorkbenchConfig,
	issues: DoctorIssue[],
): Promise<void> {
	// ── P0-2: the two `workbench.yaml` keys that used to be read by nothing ──
	// `protection.gitHook` and `config.project` were declared, schema-validated
	// and settable while no code consumed them. These two checks are their
	// consumers: an assertion in the config file now has to hold, or doctor says
	// so instead of the option quietly meaning nothing.
	if (config.protection.gitHook) {
		const actualRoot = resolve(bb.projectRoot);
		const hooksDir = join(actualRoot, ".git", "hooks");
		for (const hook of ["post-merge", "post-checkout", "post-rewrite"]) {
			if (!(await pathExists(join(hooksDir, hook)))) {
				issues.push({
					check: "git_hook_missing",
					severity: "error",
					message:
						`protection.gitHook = true，但 .git/hooks/${hook} 不存在：` +
						"git 的 merge / rebase / checkout 写入不会被登记为 git 写者" +
						"（安装：node packages/context-rot/scripts/install-hooks.mjs .）",
					subject: hook,
				});
			}
		}
	}

	if (config.project !== "") {
		const actualRoot = resolve(bb.projectRoot);
		const declared = resolve(actualRoot, config.project);
		if (declared !== actualRoot) {
			issues.push({
				check: "project_path_mismatch",
				severity: "warning",
				message:
					`workbench.yaml 记录的 project=${config.project} 解析为 ${declared}，` +
					`当前项目目录是 ${actualRoot}（账本被移动过？），记录的路径已不描述现状`,
				subject: actualRoot,
			});
		}
	}
}
