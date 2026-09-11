import { AnimatePresence, motion } from "motion/react";
import { useEffect } from "react";
import { GitFork, X } from "@/components/icon";
import { apiFetch } from "../../auth";
import { useChatStore } from "../../chat/store";
import { TWEEN_FAST } from "../../lib/motion";
import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";

/** 计划批准卡：批准后以 acceptEdits 恢复执行。 */
export function PlanApproval() {
	const send = useChatStore((s) => s.send);
	const setPlanMode = useChatStore((s) => s.setPlanMode);
	const busy = useChatStore((s) => s.runningThreadId !== null);
	const approve = async () => {
		await apiFetch(`/api/chat/threads/${useChatStore.getState().activeId}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ permissionMode: "acceptEdits" }),
		});
		await send("计划已批准。请严格按照上面的计划开始执行。");
	};
	return (
		<div className="rounded-xl border border-status-info/40 bg-status-info/5 px-4 py-3">
			<p className="text-small text-fg-muted">
				以上是规划模式产出的计划。批准后将切换到执行模式继续本会话。
			</p>
			<div className="mt-2 flex gap-2">
				<Button size="sm" disabled={busy} onClick={() => void approve()}>
					批准并执行
				</Button>
				<Button
					size="sm"
					variant="outline"
					disabled={busy}
					onClick={() => void setPlanMode(false)}
				>
					退出规划模式
				</Button>
			</div>
		</div>
	);
}

/** 分叉继承声明：继承边界可见，但不引入树导航。 */
export function ForkNotice() {
	const notice = useChatStore((s) => s.forkNotice);
	const dismiss = useChatStore((s) => s.dismissForkNotice);
	useEffect(() => {
		if (!notice) return;
		const timer = setTimeout(dismiss, 8000);
		return () => clearTimeout(timer);
	}, [notice, dismiss]);
	return (
		<AnimatePresence initial={false}>
			{notice ? (
				<motion.div
					initial={{ y: -4, opacity: 0 }}
					animate={{ y: 0, opacity: 1 }}
					exit={{ y: -4, opacity: 0 }}
					transition={TWEEN_FAST}
					className="mx-4 mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-border-subtle bg-bg-surface px-3 py-2 text-small text-fg-muted sm:mx-6"
				>
					<GitFork className="mt-0.5 size-3.5 shrink-0 text-accent-default" />
					<span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
						{notice.text}
					</span>
					<button
						type="button"
						onClick={() =>
							void useChatStore.getState().switchThread(notice.threadId)
						}
						className="shrink-0 cursor-pointer text-micro text-accent-default hover:underline"
					>
						跳转到新线程
					</button>
					<Tooltip content="关闭分叉提示">
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label="关闭分叉提示"
							onClick={dismiss}
							className="text-fg-muted"
						>
							<X className="size-3" />
						</Button>
					</Tooltip>
				</motion.div>
			) : null}
		</AnimatePresence>
	);
}
