import { AuiIf, MessagePrimitive } from "@assistant-ui/react";
import { useState } from "react";
import { ChevronDown, Command, Loader2 } from "@/components/icon";
import { useChatStore } from "../../chat/store";
import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";
import { AnimatedDisclosure } from "./animated-disclosure";
import { CollapsedToolGroup, isCollapsedGroup } from "./collapsed-tool-group";
import { MarkdownText } from "./markdown-text";
import {
	AssistantActions,
	CopyAction,
	ForkAction,
	ForkAnchor,
} from "./message-actions";
import { isNotice, NoticeRow } from "./notice-row";
import { ToolCallCard } from "./tool-call-card";

export function UserMessage({ messageId }: { messageId: string }) {
	return (
		<MessagePrimitive.Root className="group relative flex min-w-0 flex-col items-end gap-1">
			<ForkAnchor messageId={messageId} />
			<div className="max-w-[88%] rounded-2xl rounded-tr-md border border-border-subtle bg-bg-elevated px-4 py-3 text-body leading-relaxed [overflow-wrap:anywhere] sm:max-w-[85%]">
				<MessagePrimitive.Parts>
					{({ part }) =>
						part.type === "text" ? (
							<p className="whitespace-pre-wrap">{part.text}</p>
						) : null
					}
				</MessagePrimitive.Parts>
			</div>
			<div className="ui-control message-action-bar flex min-h-8 items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
				<CopyAction />
				<ForkAction messageId={messageId} />
			</div>
		</MessagePrimitive.Root>
	);
}

function VariantsPanel({ variants }: { variants: string[] }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="min-w-0">
			<Tooltip content="查看本次生成的其他回答">
				<Button
					variant="outline"
					size="sm"
					aria-expanded={open}
					onClick={() => setOpen(!open)}
				>
					备选 {variants.length}
					<ChevronDown
						className={`ui-control size-3.5 ${open ? "rotate-180" : ""}`}
					/>
				</Button>
			</Tooltip>
			<AnimatedDisclosure open={open}>
				<div className="space-y-3 pt-3">
					{variants.map((text, index) => (
						<div
							key={index}
							className="rounded-xl border border-border-subtle bg-bg-surface px-4 py-3"
						>
							<p className="mb-2 text-small text-fg-muted">备选 {index + 1}</p>
							<p className="whitespace-pre-wrap text-body leading-relaxed [overflow-wrap:anywhere]">
								{text}
							</p>
						</div>
					))}
				</div>
			</AnimatedDisclosure>
		</div>
	);
}

export function AssistantMessage({ messageId }: { messageId: string }) {
	const variants = useChatStore(
		(state) =>
			(state.activeId ? state.messages[state.activeId] : undefined)?.find(
				(message) => message.id === messageId,
			)?.variants,
	);
	return (
		<MessagePrimitive.Root className="group relative flex min-w-0 flex-col gap-2">
			<ForkAnchor messageId={messageId} />
			<div className="flex items-center gap-2 text-small font-medium text-fg-muted">
				<Command className="size-3.5" /> Workbench
			</div>
			<div className="min-w-0 py-1">
				<MessagePrimitive.Parts>
					{({ part }) => {
						if (part.type === "text")
							return part.text ? <MarkdownText /> : null;
						if (part.type === "tool-call") return <ToolCallCard {...part} />;
						if (
							part.type === "data" &&
							part.name === "workbench-collapsed-group" &&
							isCollapsedGroup(part.data)
						) {
							return (
								<CollapsedToolGroup key={part.data.id} group={part.data} />
							);
						}
						if (
							part.type === "data" &&
							part.name === "workbench-notice" &&
							isNotice(part.data)
						) {
							return <NoticeRow key={part.data.label} notice={part.data} />;
						}
						return null;
					}}
				</MessagePrimitive.Parts>
			</div>
			<AuiIf
				condition={({ message }) =>
					message.role === "assistant" && message.status.type === "running"
				}
			>
				<p
					role="status"
					className="flex items-center gap-2 text-small text-fg-muted"
				>
					<Loader2 className="size-3 animate-spin" /> 正在回复…
				</p>
			</AuiIf>
			{variants?.length ? <VariantsPanel variants={variants} /> : null}
			<AssistantActions messageId={messageId} />
		</MessagePrimitive.Root>
	);
}
