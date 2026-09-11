import {
	ThreadListItemPrimitive,
	ThreadListPrimitive,
} from "@assistant-ui/react";
import { useMemo, useState } from "react";
import {
	Archive,
	GitFork,
	MessageSquare,
	Plus,
	Trash2,
} from "@/components/icon";
import { useChatStore } from "../../chat/store";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";

/** Forks remain peers; the temporary outline shows shared lineage without a tree. */
export function ThreadListSidebar({ onNavigate }: { onNavigate?: () => void }) {
	const threads = useChatStore((state) => state.threads);
	const activeId = useChatStore((state) => state.activeId);
	const [hoveredId, setHoveredId] = useState<string | null>(null);
	const [focusedId, setFocusedId] = useState<string | null>(null);
	const byId = useMemo(
		() => new Map(threads.map((thread) => [thread.id, thread])),
		[threads],
	);
	const lineage = useMemo(() => {
		const id = hoveredId ?? focusedId;
		if (!id) return null;
		const sourceId = byId.get(id)?.forkOf?.sourceThreadId ?? id;
		const related = new Set(
			threads
				.filter(
					(thread) =>
						thread.id === sourceId ||
						thread.forkOf?.sourceThreadId === sourceId,
				)
				.map((thread) => thread.id),
		);
		return related.size > 1 ? related : null;
	}, [hoveredId, focusedId, byId, threads]);

	return (
		<ThreadListPrimitive.Root className="flex min-h-0 flex-1 flex-col px-3 pb-3">
			<ThreadListPrimitive.New asChild>
				<Button
					variant="outline"
					size="lg"
					className="mb-5 mt-1 w-full justify-start gap-2 bg-bg-elevated"
					onClick={onNavigate}
				>
					<Plus className="size-4" /> 新对话
				</Button>
			</ThreadListPrimitive.New>
			<p className="mb-2 px-2 text-mini font-medium text-fg-muted">对话</p>
			<div className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain">
				<ThreadListPrimitive.Items>
					{({ threadListItem }) => {
						const thread = byId.get(threadListItem.id);
						const forkOf = thread?.forkOf;
						const active = activeId === threadListItem.id;
						return (
							<ThreadListItemPrimitive.Root
								className="group/item relative"
								data-lineage-id={threadListItem.id}
								onFocusCapture={() => setFocusedId(threadListItem.id)}
								onBlurCapture={(event) => {
									if (!event.currentTarget.contains(event.relatedTarget))
										setFocusedId(null);
								}}
								onPointerEnter={() => setHoveredId(threadListItem.id)}
								onPointerLeave={() => setHoveredId(null)}
							>
								<div
									className={cn(
										"ui-row relative flex min-h-11 items-center gap-1 rounded-lg px-2 hover:bg-muted/60",
										active && "bg-muted text-fg-default",
										lineage?.has(threadListItem.id) &&
											"ring-1 ring-accent-default/30 ring-inset",
									)}
								>
									{forkOf ? (
										<GitFork className="size-3.5 shrink-0 text-fg-muted" />
									) : (
										<MessageSquare className="size-3.5 shrink-0 text-fg-subtle" />
									)}
									<Tooltip content={thread?.title || "新对话"} side="right">
										<ThreadListItemPrimitive.Trigger
											aria-current={active ? "page" : undefined}
											onClick={onNavigate}
											className="min-w-0 flex-1 cursor-pointer truncate rounded-md px-1.5 py-3 text-left text-ui"
										>
											<ThreadListItemPrimitive.Title />
										</ThreadListItemPrimitive.Trigger>
									</Tooltip>
									{forkOf ? (
										<Tooltip
											content={
												"继承自「" +
												forkOf.sourceTitle +
												"」的前 " +
												forkOf.inheritedMessages +
												" 条消息；模型上下文继承以分叉声明为准。"
											}
											side="right"
										>
											<span className="shrink-0 rounded-md bg-bg-elevated px-1.5 py-0.5 text-mini text-fg-muted">
												继承 {forkOf.inheritedMessages}
											</span>
										</Tooltip>
									) : null}
									<div className="ui-control pointer-events-none absolute right-1 flex items-center rounded-lg border border-border-subtle bg-bg-surface p-0.5 opacity-0 shadow-sm group-hover/item:pointer-events-auto group-hover/item:opacity-100 group-focus-within/item:pointer-events-auto group-focus-within/item:opacity-100 [@media(hover:none)]:static [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:border-0 [@media(hover:none)]:opacity-100 [@media(hover:none)]:shadow-none">
										<Tooltip content="归档对话">
											<ThreadListItemPrimitive.Archive asChild>
												<Button
													variant="ghost"
													size="icon-sm"
													aria-label="归档"
													className="text-fg-muted"
												>
													<Archive className="size-3.5" />
												</Button>
											</ThreadListItemPrimitive.Archive>
										</Tooltip>
										<Tooltip content="删除对话">
											<ThreadListItemPrimitive.Delete asChild>
												<Button
													variant="ghost"
													size="icon-sm"
													aria-label="删除"
													className="text-fg-muted hover:bg-status-danger/10 hover:text-status-danger"
												>
													<Trash2 className="size-3.5" />
												</Button>
											</ThreadListItemPrimitive.Delete>
										</Tooltip>
									</div>
								</div>
							</ThreadListItemPrimitive.Root>
						);
					}}
				</ThreadListPrimitive.Items>
			</div>
		</ThreadListPrimitive.Root>
	);
}
