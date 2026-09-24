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

export { hostFilesystemGuardReason } from "./guard";
export {
	HOST_GUARD_ENV,
	type HostFilesystemProbe,
	type HostFilesystemVerdict,
	hostGuardDisabled,
	probeHostFilesystem,
	resetHostFilesystemProbe,
} from "./probe";
export { isReadOnlyGitCommand } from "./read-only";
