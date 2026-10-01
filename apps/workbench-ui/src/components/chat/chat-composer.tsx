import { AuiIf, ComposerPrimitive, ThreadPrimitive } from "@assistant-ui/react";
import { ArrowDown, ArrowUp, ListChecks, Square } from "@/components/icon";
import { useChatStore } from "../../chat/store";
import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";
import { ThreadSidecar } from "./sidecar";
import { PlanApproval } from "./thread-notices";

export function ChatComposer() {
	const planMode = useChatStore(
		(state) =>
			state.threads.find((thread) => thread.id === state.activeId)
				?.permissionMode === "plan",
	);
	const busy = useChatStore((state) => state.runningThreadId !== null);
	const lastRole = useChatStore((state) =>
		state.activeId ? state.messages[state.activeId]?.at(-1)?.role : undefined,
	);
	const setPlanMode = useChatStore((state) => state.setPlanMode);
	return (
		<ThreadPrimitive.ViewportFooter className="relative shrink-0 px-4 pb-4 pt-2 sm:px-6 sm:pb-5">
			<div className="relative mx-auto w-full max-w-3xl">
				<Tooltip content="回到最新消息">
					<ThreadPrimitive.ScrollToBottom asChild>
						<Button
							variant="outline"
							size="icon"
							aria-label="回到最新消息"
							className="absolute -top-12 left-1/2 -translate-x-1/2 rounded-full bg-bg-elevated shadow-sm disabled:hidden"
						>
							<ArrowDown />
						</Button>
					</ThreadPrimitive.ScrollToBottom>
				</Tooltip>
				<div className="max-h-[35dvh] overflow-y-auto overscroll-contain">
					<ThreadSidecar />
					{planMode && !busy && lastRole === "assistant" ? (
						<div className="mb-3">
							<PlanApproval />
						</div>
					) : null}
				</div>
				<ComposerPrimitive.Root className="ui-control overflow-hidden rounded-2xl border border-border bg-bg-surface p-3 shadow-sm focus-within:border-ring/60 focus-within:ring-2 focus-within:ring-ring/10">
					<ComposerPrimitive.Input
						rows={2}
						aria-label="消息"
						placeholder={
							planMode ? "描述你想规划的任务…" : "输入消息，开始讨论…"
						}
						className="max-h-44 min-h-16 w-full resize-none bg-transparent px-1 py-1 text-body leading-relaxed text-fg-default outline-none placeholder:text-fg-muted"
					/>
					<div className="mt-2 flex items-center gap-2">
						<Tooltip content="规划模式仅在 Claude CLI 进程启动时读取；切换不会改变当前已启动的进程">
							<Button
								size="sm"
								variant={planMode ? "secondary" : "ghost"}
								aria-pressed={planMode}
								disabled={busy}
								onClick={() => void setPlanMode(!planMode)}
								className="text-fg-muted"
							>
								<ListChecks className="size-3.5" />
								{planMode ? "规划已选" : "规划"}
							</Button>
						</Tooltip>
						<span className="ml-auto hidden text-mini text-fg-muted sm:inline">
							Shift + Enter 换行
						</span>
						<AuiIf condition={({ thread }) => thread.isRunning}>
							<Tooltip content="停止生成">
								<ComposerPrimitive.Cancel asChild>
									<Button
										size="icon"
										variant="outline"
										aria-label="停止"
										className="ml-auto sm:ml-1"
									>
										<Square className="size-3.5 fill-current" />
									</Button>
								</ComposerPrimitive.Cancel>
							</Tooltip>
						</AuiIf>
						<AuiIf condition={({ thread }) => !thread.isRunning}>
							<Tooltip content="发送消息 · Enter">
								<ComposerPrimitive.Send asChild>
									<Button
										size="icon"
										aria-label="发送"
										className="ml-auto sm:ml-1"
									>
										<ArrowUp />
									</Button>
								</ComposerPrimitive.Send>
							</Tooltip>
						</AuiIf>
					</div>
					<p className="mt-2 text-mini text-fg-muted">
						规划开关仅对下次新启动的 Claude CLI
						进程生效；当前进程不受影响，下一回合可能仍复用当前进程。
					</p>
				</ComposerPrimitive.Root>
			</div>
		</ThreadPrimitive.ViewportFooter>
	);
}
