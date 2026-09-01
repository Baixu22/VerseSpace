import {
	ActionBarPrimitive,
	AuiIf,
	BranchPickerPrimitive,
	ComposerPrimitive,
	MessagePrimitive,
	ThreadPrimitive,
} from "@assistant-ui/react";
import { useState } from "react";
import { apiFetch } from "../../auth";
import { useChatStore } from "../../chat/store";
import { Button } from "../ui/button";
import { MarkdownText } from "./markdown-text";

function CopyAction() {
	return (
		<ActionBarPrimitive.Copy className="rounded-md px-1.5 py-0.5 text-micro text-fg-subtle hover:bg-muted hover:text-fg-default">
			复制
		</ActionBarPrimitive.Copy>
	);
}

function UserMessage() {
	return (
		<MessagePrimitive.Root className="group flex flex-col items-end gap-1">
			<div className="max-w-[80%] rounded-xl bg-primary px-4 py-2.5 text-body text-primary-foreground">
				<MessagePrimitive.Parts>
					{({ part }) =>
						part.type === "text" ? (
							<p className="whitespace-pre-wrap">{part.text}</p>
						) : null
					}
				</MessagePrimitive.Parts>
			</div>
			<div className="opacity-0 transition-opacity group-hover:opacity-100">
				<CopyAction />
			</div>
		</MessagePrimitive.Root>
	);
}

function ToolCallCard({
	toolName,
	args,
	result,
}: {
	toolName: string;
	args: unknown;
	result?: unknown;
}) {
	const [open, setOpen] = useState(false);
	return (
		<div className="my-1 rounded-lg border border-border-subtle bg-bg-base">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
			>
				<span className="rounded bg-status-info/15 px-1.5 py-0.5 font-mono text-micro text-status-info">
					{toolName}
				</span>
				<span className="truncate font-mono text-micro text-fg-muted">
					{JSON.stringify(args).slice(0, 90)}
				</span>
				<span className="ml-auto font-mono text-micro text-fg-subtle">
					{open ? "收起" : "展开"}
				</span>
			</button>
			{open ? (
				<>
					<pre className="overflow-x-auto border-t border-border-subtle px-3 py-2 font-mono text-micro text-fg-muted">
						{JSON.stringify(args, null, 2)}
					</pre>
					{result !== undefined ? (
						<pre className="overflow-x-auto border-t border-border-subtle px-3 py-2 font-mono text-micro text-status-success">
							{typeof result === "string"
								? result
								: JSON.stringify(result, null, 2)}
						</pre>
					) : null}
				</>
			) : null}
		</div>
	);
}

function AssistantMessage() {
	return (
		<MessagePrimitive.Root className="group flex flex-col gap-1">
			<div className="max-w-[92%] rounded-xl border border-border bg-bg-surface px-4 py-3">
				<MessagePrimitive.Parts>
					{({ part }) => {
						if (part.type === "text") {
							return part.text ? <MarkdownText /> : null;
						}
						if (part.type === "tool-call") {
							return (
								<ToolCallCard
									toolName={part.toolName}
									args={part.args}
									result={part.result}
								/>
							);
						}
						return null;
					}}
				</MessagePrimitive.Parts>
			</div>
			<div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
				<CopyAction />
				<ActionBarPrimitive.Reload className="rounded-md px-1.5 py-0.5 text-micro text-fg-subtle hover:bg-muted hover:text-fg-default">
					重试
				</ActionBarPrimitive.Reload>
				<ActionBarPrimitive.Speak className="rounded-md px-1.5 py-0.5 text-micro text-fg-subtle hover:bg-muted hover:text-fg-default">
					朗读
				</ActionBarPrimitive.Speak>
				<ActionBarPrimitive.StopSpeaking className="rounded-md px-1.5 py-0.5 text-micro text-fg-subtle hover:bg-muted hover:text-fg-default">
					停止
				</ActionBarPrimitive.StopSpeaking>
				<ActionBarPrimitive.FeedbackPositive className="rounded-md px-1.5 py-0.5 text-micro text-fg-subtle data-[feedback-positive]:text-status-success hover:bg-muted hover:text-fg-default">
					👍
				</ActionBarPrimitive.FeedbackPositive>
				<ActionBarPrimitive.FeedbackNegative className="rounded-md px-1.5 py-0.5 text-micro text-fg-subtle data-[feedback-negative]:text-status-danger hover:bg-muted hover:text-fg-default">
					👎
				</ActionBarPrimitive.FeedbackNegative>
				<BranchPickerPrimitive.Root className="flex items-center gap-1 text-micro text-fg-subtle">
					<BranchPickerPrimitive.Previous className="px-1 hover:text-fg-default">
						‹
					</BranchPickerPrimitive.Previous>
					<BranchPickerPrimitive.Number />
					<span>/</span>
					<BranchPickerPrimitive.Count />
					<BranchPickerPrimitive.Next className="px-1 hover:text-fg-default">
						›
					</BranchPickerPrimitive.Next>
				</BranchPickerPrimitive.Root>
			</div>
		</MessagePrimitive.Root>
	);
}

/** 计划批准卡：plan 模式的最后回复即计划，批准后以 acceptEdits 恢复执行。 */
function PlanApproval() {
	const send = useChatStore((s) => s.send);
	const setPlanMode = useChatStore((s) => s.setPlanMode);
	const busy = useChatStore((s) => s.runningThreadId !== null);

	const approve = async () => {
		// 切到执行模式：下一次（resume）调用以 acceptEdits 运行，跑完自动回 default
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

export function ChatThread() {
	const threads = useChatStore((s) => s.threads);
	const activeId = useChatStore((s) => s.activeId);
	const runningThreadId = useChatStore((s) => s.runningThreadId);
	const messages = useChatStore((s) =>
		s.activeId ? s.messages[s.activeId] : undefined,
	);
	const setPlanMode = useChatStore((s) => s.setPlanMode);
	const activeThread = threads.find((t) => t.id === activeId);
	const planMode = activeThread?.permissionMode === "plan";
	const lastMessage = messages?.at(-1);
	const showPlanApproval =
		planMode && !runningThreadId && lastMessage?.role === "assistant";

	return (
		<ThreadPrimitive.Root className="flex h-full min-w-0 flex-1 flex-col">
			<ThreadPrimitive.Viewport className="flex-1 overflow-y-auto px-6 py-4">
				<ThreadPrimitive.Empty>
					<div className="flex h-full flex-col items-center justify-center gap-2 text-fg-muted">
						<p className="text-heading">Workbench</p>
						<p className="text-small">
							对话由 workbench runtime 承载——线程持久化在
							.workbench/，多线程并行互不阻塞
						</p>
					</div>
				</ThreadPrimitive.Empty>
				<ThreadPrimitive.Messages>
					{({ message }) =>
						message.role === "user" ? <UserMessage /> : <AssistantMessage />
					}
				</ThreadPrimitive.Messages>
			</ThreadPrimitive.Viewport>

			<ThreadPrimitive.ViewportFooter className="px-6 pb-5">
				{showPlanApproval ? (
					<div className="mb-3">
						<PlanApproval />
					</div>
				) : null}
				<ComposerPrimitive.Root className="flex items-end gap-2 rounded-xl border border-border bg-bg-surface p-2.5">
					<ComposerPrimitive.Input
						rows={1}
						placeholder={
							planMode
								? "规划模式：描述要规划的任务…（Enter 发送）"
								: "输入消息…（Enter 发送，Shift+Enter 换行）"
						}
						className="max-h-40 min-h-8 flex-1 resize-none bg-transparent px-2 py-1.5 text-body outline-none"
					/>
					<Button
						size="sm"
						variant={planMode ? "default" : "outline"}
						title="规划模式：探索与产出计划，不执行修改"
						onClick={() => void setPlanMode(!planMode)}
					>
						{planMode ? "规划中" : "规划"}
					</Button>
					<AuiIf condition={({ thread }) => thread.isRunning}>
						<ComposerPrimitive.Cancel className="h-8 rounded-lg border border-border px-3 text-small hover:bg-muted">
							停止
						</ComposerPrimitive.Cancel>
					</AuiIf>
					<AuiIf condition={({ thread }) => !thread.isRunning}>
						<ComposerPrimitive.Send className="h-8 rounded-lg bg-primary px-4 text-small text-primary-foreground disabled:opacity-50">
							发送
						</ComposerPrimitive.Send>
					</AuiIf>
				</ComposerPrimitive.Root>
				<p className="mt-1.5 text-center text-micro text-fg-subtle">
					由 workbench runtime 驱动 · 线程并行 · 会话持久化
				</p>
			</ThreadPrimitive.ViewportFooter>
		</ThreadPrimitive.Root>
	);
}
