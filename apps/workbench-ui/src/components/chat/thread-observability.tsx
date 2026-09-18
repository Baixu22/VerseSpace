import type { ThreadMeta } from "../../chat/message-types";
import { Tooltip } from "../ui/tooltip";

/**
 * TF-0191 线程头的诚实标注。只在有话要说时渲染：
 * - 最近一轮的 provider 没有工具通道 → 读集不可观测、不参与前提继承；
 * - 分叉继承观测里有任一开关为 false → 两个开关分开写，不合成一个布尔。
 * 可观测且继承完整的线程什么都不显示（无分歧不渲染）。
 */
export function ThreadObservability({ thread }: { thread: ThreadMeta }) {
	const unobservable = thread.lastRun?.readObservability === "unobservable";
	const inheritance = thread.forkInheritance;
	const inheritanceGap =
		inheritance &&
		(inheritance.agentContextInherited === false ||
			inheritance.premiseInherited === false);
	if (!unobservable && !inheritanceGap) return null;
	return (
		<>
			{unobservable ? (
				<Tooltip
					content={`最近一轮走 ${thread.lastRun?.provider}：这类 HTTP provider 没有工具通道，agent 读了什么文件不会留下足迹，所以前提失效时无法判断它是否受影响，也不能作为分叉继承的读集来源。要让读集可观测，请在设置里切换到 claude。`}
					side="bottom"
				>
					<span
						className="cursor-help rounded-md border border-border-subtle px-1.5 py-px font-mono text-fg-subtle"
						data-testid="thread-unobservable"
					>
						{thread.lastRun?.provider} · 读集不可观测，不参与前提继承
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
