import { AlertTriangle, Info } from "@/components/icon";
import type { NoticePart } from "../../chat/message-types";

/**
 * Narrowing guard for the wire shape, mirroring `isCollapsedGroup`: the data
 * payload of a custom assistant-ui part arrives untyped, so a hostile or
 * drifted provider must not be able to paint the thread.
 */
export function isNotice(value: unknown): value is NoticePart {
	if (!value || typeof value !== "object") return false;
	const part = value as Record<string, unknown>;
	return (
		part.type === "notice" &&
		(part.severity === "info" || part.severity === "warning") &&
		typeof part.label === "string" &&
		(part.body === undefined || typeof part.body === "string")
	);
}

/**
 * A provider notice inside an assistant message — today the CLI refusing an
 * action. It is the agent's *context*, not the agent's words, so it renders as
 * a strip rather than as message text and never joins the copyable answer.
 */
export function NoticeRow({ notice }: { notice: NoticePart }) {
	const Icon = notice.severity === "info" ? Info : AlertTriangle;
	return (
		<div
			role="status"
			data-severity={notice.severity}
			className="min-w-0 rounded-lg border border-border-subtle bg-status-warning/10 px-3 py-2 text-small data-[severity=info]:bg-bg-surface data-[severity=info]:text-fg-muted"
		>
			<span className="flex items-center gap-1.5 font-medium text-status-warning data-[severity=info]:text-fg-muted">
				<Icon className="size-3.5 shrink-0" /> {notice.label}
			</span>
			{notice.body ? (
				<p className="mt-1 text-fg-muted [overflow-wrap:anywhere]">
					{notice.body}
				</p>
			) : null}
		</div>
	);
}
