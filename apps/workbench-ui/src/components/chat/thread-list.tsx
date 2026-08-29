import {
	ThreadListItemPrimitive,
	ThreadListPrimitive,
} from "@assistant-ui/react";

/**
 * Thread sidebar built from the real ThreadListPrimitive family — the data
 * comes from the external-store threadList adapter (workbench server files).
 */
export function ThreadListSidebar() {
	return (
		<ThreadListPrimitive.Root className="flex-1 overflow-y-auto px-2 pb-3">
			<ThreadListPrimitive.New className="mx-1 mb-2 flex w-[calc(100%-8px)] items-center justify-center rounded-lg border border-border py-1.5 text-small hover:bg-muted">
				新对话
			</ThreadListPrimitive.New>
			<ThreadListPrimitive.Items>
				{() => (
					<ThreadListItemPrimitive.Root className="group/item data-[active]:bg-muted">
						<div className="flex items-center gap-1 rounded-lg px-1 hover:bg-muted">
							<ThreadListItemPrimitive.Trigger className="min-w-0 flex-1 truncate px-1.5 py-2 text-left text-small">
								<ThreadListItemPrimitive.Title />
							</ThreadListItemPrimitive.Trigger>
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
				)}
			</ThreadListPrimitive.Items>
		</ThreadListPrimitive.Root>
	);
}
