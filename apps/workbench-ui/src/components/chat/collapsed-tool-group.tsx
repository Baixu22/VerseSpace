import { useId, useState } from "react";
import {
	Check,
	ChevronDown,
	FileText,
	Loader2,
	Search,
	Terminal,
} from "@/components/icon";
import type { CollapsedGroupPart } from "../../chat/message-types";
import { AnimatedDisclosure } from "./animated-disclosure";
import { ToolCallCard } from "./tool-call-card";

export function isCollapsedGroup(value: unknown): value is CollapsedGroupPart {
	if (!value || typeof value !== "object") return false;
	const group = value as Record<string, unknown>;
	return (
		group.type === "collapsed-group" &&
		typeof group.id === "string" &&
		typeof group.summary === "string" &&
		typeof group.active === "boolean" &&
		["search", "read", "shell", "mixed"].includes(String(group.category)) &&
		Array.isArray(group.tools) &&
		group.tools.every((tool: unknown) => {
			if (!tool || typeof tool !== "object") return false;
			const part = tool as Record<string, unknown>;
			return (
				part.type === "tool-call" &&
				typeof part.toolCallId === "string" &&
				typeof part.toolName === "string" &&
				"args" in part
			);
		})
	);
}

export function CollapsedToolGroup({ group }: { group: CollapsedGroupPart }) {
	const [open, setOpen] = useState(false);
	const contentId = useId();
	const GroupIcon =
		group.category === "search"
			? Search
			: group.category === "shell"
				? Terminal
				: FileText;
	return (
		<div className="my-2 min-w-0 border-y border-border-subtle py-1">
			<button
				type="button"
				aria-expanded={open}
				aria-controls={contentId}
				onClick={() => setOpen(!open)}
				className="ui-control flex w-full cursor-pointer items-center gap-2 px-1 py-2 text-left text-small text-fg-muted hover:text-fg-default"
			>
				<GroupIcon className="size-3.5 shrink-0" />
				<span
					className="min-w-0 flex-1 truncate font-medium"
					title={group.summary}
				>
					{group.summary}
				</span>
				<span className="shrink-0 text-mini text-fg-subtle">
					{group.tools.length} 个工具
				</span>
				<span
					role="status"
					aria-label={group.active ? "工具执行中" : "工具组已结束"}
				>
					{group.active ? (
						<Loader2 className="size-3.5 shrink-0 animate-spin" />
					) : (
						<Check className="size-3.5 shrink-0 text-fg-muted" />
					)}
				</span>
				<ChevronDown
					className={`ui-control size-3.5 shrink-0 ${open ? "rotate-180" : ""}`}
				/>
			</button>
			<AnimatedDisclosure open={open}>
				<div id={contentId} className="border-t border-border-subtle pt-1">
					{group.tools.map((tool) => (
						<ToolCallCard key={tool.toolCallId} {...tool} />
					))}
				</div>
			</AnimatedDisclosure>
		</div>
	);
}
