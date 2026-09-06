import {
	ThreadListItemPrimitive,
	ThreadListPrimitive,
} from "@assistant-ui/react";
import { useMemo } from "react";
import { useChatStore } from "../../chat/store";

/**
 * Thread sidebar built from the real ThreadListPrimitive family — the data
 * comes from the external-store threadList adapter (workbench server files).
 *
 * 分叉线程（TF-0093）在标题旁渲染血统徽标：分叉结果必须在线程列表可见，
 * 且明确声明它继承了什么（悬停查看）。
 */
export function ThreadListSidebar() {
	// Selector must return a stored reference — deriving a fresh object here
	// makes the zustand snapshot uncached and loops React into error #185
	// (Maximum update depth) on first mount.
	const threads = useChatStore((s) => s.threads);
	const forkOfById = useMemo(
		() =>
			Object.fromEntries(
				threads
					.filter((t) => t.forkOf)
					.map((t) => [t.id, t.forkOf as NonNullable<typeof t.forkOf>]),
			),
		[threads],
	);
	return (
		<ThreadListPrimitive.Root className="flex-1 overflow-y-auto px-2 pb-3">
			<ThreadListPrimitive.New className="mx-1 mb-2 flex w-[calc(100%-8px)] items-center justify-center rounded-lg border border-border py-1.5 text-small hover:bg-muted">
				新对话
			</ThreadListPrimitive.New>
			<ThreadListPrimitive.Items>
				{({ threadListItem }) => {
					const forkOf = forkOfById[threadListItem.id];
					return (
						<ThreadListItemPrimitive.Root className="group/item data-[active]:bg-muted">
							<div className="flex items-center gap-1 rounded-lg px-1 hover:bg-muted">
								<ThreadListItemPrimitive.Trigger className="min-w-0 flex-1 truncate px-1.5 py-2 text-left text-small">
									{forkOf ? <span aria-hidden>↳ </span> : null}
									<ThreadListItemPrimitive.Title />
								</ThreadListItemPrimitive.Trigger>
								{forkOf ? (
									<span
										title={`继承自「${forkOf.sourceTitle}」的前 ${forkOf.inheritedMessages} 条消息（到此为止）；agent 会话从新开始`}
										className="shrink-0 rounded bg-muted px-1 text-micro text-fg-subtle"
									>
										分叉
									</span>
								) : null}
								<div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/item:opacity-100">
									<ThreadListItemPrimitive.Archive className="px-1 text-micro text-fg-subtle hover:text-fg-default">
										归档
									</ThreadListItemPrimitive.Archive>
									<ThreadListItemPrimitive.Delete className="px-1 text-micro text-status-danger hover:text-status-danger">
										删除
									</ThreadListItemPrimitive.Delete>
								</div>
							</div>
						</ThreadListItemPrimitive.Root>
					);
				}}
			</ThreadListPrimitive.Items>
		</ThreadListPrimitive.Root>
	);
}
