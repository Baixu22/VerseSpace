import { hostGuardDisabled, probeHostFilesystem } from "./probe";
import { isReadOnlyGitCommand } from "./read-only";

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
