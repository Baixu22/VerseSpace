import { useId, useState } from "react";
import { ChevronDown, Terminal } from "@/components/icon";
import { AnimatedDisclosure } from "./animated-disclosure";

export function ToolCallCard({
	toolName,
	args,
	result,
	isError,
}: {
	toolName: string;
	args: unknown;
	result?: unknown;
	isError?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const contentId = useId();
	return (
		<div className="my-2 min-w-0 overflow-hidden rounded-xl border border-border-subtle bg-bg-surface">
			<button
				type="button"
				aria-expanded={open}
				aria-controls={contentId}
				onClick={() => setOpen(!open)}
				className="ui-control flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left text-small hover:bg-muted/50"
			>
				<Terminal className="size-3.5 shrink-0 text-fg-muted" />
				<span className="shrink-0 font-medium">{toolName}</span>
				<span className="min-w-0 flex-1 truncate font-mono text-fg-muted">
					{(JSON.stringify(args) ?? "").slice(0, 90)}
				</span>
				{isError ? <span className="text-status-danger">失败</span> : null}
				<ChevronDown
					className={`ui-control size-3.5 shrink-0 text-fg-muted ${open ? "rotate-180" : ""}`}
				/>
			</button>
			<AnimatedDisclosure open={open}>
				<div id={contentId} className="border-t border-border-subtle">
					<pre className="max-h-60 overflow-auto px-3 py-3 font-mono text-small text-fg-muted">
						{JSON.stringify(args, null, 2)}
					</pre>
					{result !== undefined ? (
						<pre className="max-h-60 overflow-auto border-t border-border-subtle px-3 py-3 font-mono text-small text-fg-muted">
							{typeof result === "string"
								? result
								: JSON.stringify(result, null, 2)}
						</pre>
					) : null}
				</div>
			</AnimatedDisclosure>
		</div>
	);
}
