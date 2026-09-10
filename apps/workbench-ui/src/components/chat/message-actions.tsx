import {
	ActionBarPrimitive,
	AuiIf,
	BranchPickerPrimitive,
	useAuiState,
} from "@assistant-ui/react";
import {
	Check,
	ChevronLeft,
	ChevronRight,
	Copy,
	GitFork,
	Loader2,
	RotateCcw,
	Square,
	ThumbsDown,
	ThumbsUp,
	Volume2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useChatStore } from "../../chat/store";
import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";

export function CopyAction() {
	const copied = useAuiState((state) => state.message.isCopied);
	return (
		<Tooltip content={copied ? "已复制" : "复制消息"}>
			<ActionBarPrimitive.Copy asChild>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="复制"
					className="text-fg-muted"
				>
					{copied ? <Check className="text-status-success" /> : <Copy />}
				</Button>
			</ActionBarPrimitive.Copy>
		</Tooltip>
	);
}

export function ForkAction({ messageId }: { messageId: string }) {
	const busy = useChatStore((state) => state.runningThreadId !== null);
	const [state, setState] = useState<"idle" | "loading" | "done" | "error">(
		"idle",
	);
	useEffect(() => {
		if (state !== "done") return;
		const timer = setTimeout(() => setState("idle"), 1200);
		return () => clearTimeout(timer);
	}, [state]);
	const fork = async () => {
		if (busy || state === "loading" || state === "done") return;
		setState("loading");
		try {
			const threadId = await useChatStore.getState().fork(messageId);
			setState(threadId ? "done" : "idle");
		} catch {
			setState("error");
		}
	};
	return (
		<Tooltip
			content={
				state === "done"
					? "已创建分叉"
					: state === "error"
						? "分叉失败，点击重试"
						: "从此处分叉，保留原对话"
			}
		>
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label="分叉"
				disabled={busy || state === "loading" || state === "done"}
				onClick={() => void fork()}
				className={state === "error" ? "text-status-danger" : "text-fg-muted"}
			>
				{state === "loading" ? (
					<Loader2 className="animate-spin" />
				) : state === "done" ? (
					<Check className="text-status-success" />
				) : (
					<GitFork />
				)}
			</Button>
		</Tooltip>
	);
}

/** A single return link keeps branch navigation flat. */
export function ForkAnchor({ messageId }: { messageId: string }) {
	const threads = useChatStore((state) => state.threads);
	const activeId = useChatStore((state) => state.activeId);
	const count =
		threads.find((thread) => thread.id === activeId)?.forks?.[messageId] ?? 0;
	const target = threads.find(
		(thread) =>
			thread.forkOf?.sourceThreadId === activeId &&
			thread.forkOf.anchorMessageId === messageId,
	);
	if (count === 0) return null;
	return (
		<Tooltip
			content={
				"已在此处分叉 " +
				count +
				" 次" +
				(target ? ` · 跳转到「${target.title}」` : "")
			}
			side="right"
		>
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label={`查看分叉 ${count} 次`}
				disabled={!target}
				onClick={() =>
					target && void useChatStore.getState().switchThread(target.id)
				}
				className="absolute -left-4 top-3 h-6 w-3 text-accent-default"
			>
				<span className="h-4 w-0.5 rounded-full bg-current" />
			</Button>
		</Tooltip>
	);
}

export function AnimatedBranchPicker() {
	const number = useAuiState((state) => state.message.branchNumber);
	const count = useAuiState((state) => state.message.branchCount);
	if (count < 2) return null;
	return (
		<BranchPickerPrimitive.Root className="flex items-center gap-0.5 rounded-md border border-border-subtle text-small text-fg-muted">
			<Tooltip content="上一个分支">
				<BranchPickerPrimitive.Previous asChild>
					<Button variant="ghost" size="icon-sm" aria-label="上一个分支">
						<ChevronLeft />
					</Button>
				</BranchPickerPrimitive.Previous>
			</Tooltip>
			<span className="min-w-8 text-center tabular-nums">
				{number} / {count}
			</span>
			<Tooltip content="下一个分支">
				<BranchPickerPrimitive.Next asChild>
					<Button variant="ghost" size="icon-sm" aria-label="下一个分支">
						<ChevronRight />
					</Button>
				</BranchPickerPrimitive.Next>
			</Tooltip>
		</BranchPickerPrimitive.Root>
	);
}

export function AssistantActions({ messageId }: { messageId: string }) {
	return (
		<div className="message-action-bar flex min-h-8 flex-wrap items-center gap-1 text-fg-muted">
			<CopyAction />
			<ForkAction messageId={messageId} />
			<Tooltip content="重新生成回答">
				<ActionBarPrimitive.Reload asChild>
					<Button variant="ghost" size="icon-sm" aria-label="重试">
						<RotateCcw />
					</Button>
				</ActionBarPrimitive.Reload>
			</Tooltip>
			<AuiIf condition={({ message }) => message.speech == null}>
				<Tooltip content="朗读回答">
					<ActionBarPrimitive.Speak asChild>
						<Button variant="ghost" size="icon-sm" aria-label="朗读">
							<Volume2 />
						</Button>
					</ActionBarPrimitive.Speak>
				</Tooltip>
			</AuiIf>
			<AuiIf condition={({ message }) => message.speech != null}>
				<Tooltip content="停止朗读">
					<ActionBarPrimitive.StopSpeaking asChild>
						<Button variant="ghost" size="icon-sm" aria-label="停止朗读">
							<Square />
						</Button>
					</ActionBarPrimitive.StopSpeaking>
				</Tooltip>
			</AuiIf>
			<span className="mx-1 h-3 w-px bg-border-subtle" />
			<Tooltip content="有帮助">
				<ActionBarPrimitive.FeedbackPositive asChild>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="有帮助"
						className="data-[feedback-positive]:text-status-success"
					>
						<ThumbsUp />
					</Button>
				</ActionBarPrimitive.FeedbackPositive>
			</Tooltip>
			<Tooltip content="需要改进">
				<ActionBarPrimitive.FeedbackNegative asChild>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="需要改进"
						className="data-[feedback-negative]:text-status-danger"
					>
						<ThumbsDown />
					</Button>
				</ActionBarPrimitive.FeedbackNegative>
			</Tooltip>
			<AnimatedBranchPicker />
		</div>
	);
}
