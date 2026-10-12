import type { ThreadMeta } from "../../chat/message-types";
import { Tooltip } from "../ui/tooltip";

/**
 * TF-0191 线程头的诚实标注。只在有话要说时渲染：
 * - 最近一轮的 provider 没有工具通道 → 读集不可观测、不参与前提继承；
 * - 分叉继承观测里有任一开关为 false → 两个开关分开写，不合成一个布尔；
 * - 上一轮由兜底目标应答（switchedFrom 有值）→ 标出切换，避免把回答误认成主目标；
 * - provider 上报了缓存用量 → 显示命中率，让缓存键是否生效可见（阶段二）。
 * 可观测、未切换、无缓存数据且继承完整的线程什么都不显示（无分歧不渲染）。
 */
function formatCacheHit(
	usage: NonNullable<ThreadMeta["lastRun"]>["usage"],
): string | null {
	if (!usage || usage.promptTokens <= 0) return null;
	return `${Math.round((usage.cachedTokens / usage.promptTokens) * 100)}%`;
}

export function ThreadObservability({ thread }: { thread: ThreadMeta }) {
	const lastRun = thread.lastRun;
	const experimental = lastRun?.provider === "codex";
	const unobservable = lastRun?.readObservability === "unobservable";
	const switched = Boolean(lastRun?.switchedFrom);
	const cacheHit = formatCacheHit(lastRun?.usage);
	const inheritance = thread.forkInheritance;
	const inheritanceGap =
		inheritance &&
		(inheritance.agentContextInherited === false ||
			inheritance.premiseInherited === false);
	if (
		!unobservable &&
		!inheritanceGap &&
		!experimental &&
		!switched &&
		!cacheHit
	) {
		return null;
	}
	return (
		<>
			{experimental ? (
				<Tooltip
					content="Codex 足迹仅覆盖可识别的命令形状；缺失读足迹、未发起审批或目标无法归因时，封印不能保护写入。"
					side="bottom"
				>
					<span
						className="cursor-help rounded-md border border-border-subtle px-1.5 py-px text-fg-subtle"
						data-testid="thread-codex-experimental"
					>
						Codex 实验通道 · 写保护未验证
					</span>
				</Tooltip>
			) : null}
			{unobservable ? (
				<Tooltip
					content={`最近一轮走 ${lastRun?.provider}：这类 HTTP provider 没有工具通道，agent 读了什么文件不会留下足迹，所以前提失效时无法判断它是否受影响，也不能作为分叉继承的读集来源。要让读集可观测，请在设置里切换到 claude。`}
					side="bottom"
				>
					<span
						className="cursor-help rounded-md border border-border-subtle px-1.5 py-px font-mono text-fg-subtle"
						data-testid="thread-unobservable"
					>
						{lastRun?.provider} · 读集不可观测，不参与前提继承
					</span>
				</Tooltip>
			) : null}
			{switched ? (
				<Tooltip
					content={`本轮由 ${lastRun?.provider} 应答，配置的主目标是 ${lastRun?.switchedFrom}。主目标按 ${lastRun?.attempts ?? 1} 次尝试未成功，才切到兜底目标；这只是本轮的事实，线程绑定仍是主目标。`}
					side="bottom"
				>
					<span
						className="cursor-help rounded-md border border-border-subtle px-1.5 py-px font-mono text-fg-subtle"
						data-testid="thread-switched"
					>
						已切换 · {lastRun?.provider}
						{typeof lastRun?.attempts === "number"
							? ` · ${lastRun.attempts} 次尝试`
							: ""}
					</span>
				</Tooltip>
			) : null}
			{cacheHit ? (
				<Tooltip
					content={`上游回报 ${lastRun?.usage?.promptTokens} 提示 token，其中 ${lastRun?.usage?.cachedTokens} 命中缓存，输出 ${lastRun?.usage?.outputTokens}。这是 provider 的实际读数，缺失即未返回，不做猜测。`}
					side="bottom"
				>
					<span
						className="cursor-help rounded-md border border-border-subtle px-1.5 py-px font-mono text-fg-subtle"
						data-testid="thread-cache-usage"
					>
						缓存命中 {cacheHit}
					</span>
				</Tooltip>
			) : null}
			{inheritanceGap ? (
				<span
					className="rounded-md border border-border-subtle px-1.5 py-px text-fg-subtle"
					data-testid="thread-inheritance"
				>
					继承：agent 上下文
					{inheritance.agentContextInherited ? " 是" : " 否"} · 前提
					{inheritance.premiseInherited ? " 是" : " 否"}
				</span>
			) : null}
		</>
	);
}
