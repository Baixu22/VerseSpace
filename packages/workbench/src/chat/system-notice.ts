/**
 * Provider system events that are *information for the operator* rather than
 * facts of the turn (TF-0200 follow-up; the shape is absorbed from the frozen
 * legacy adapter's `MessagePart::SystemNotice`).
 *
 * The one that matters today is `permission_denied`: the CLI refused an action
 * and the reason (`decision_reason` / `decision_reason_type`) is not visible
 * anywhere else — the tool row only shows that the call failed. Before this
 * module the event fell through to `undecided`, i.e. it shared a bucket with
 * genuinely unknown provider protocol shapes, so a deny was both invisible to
 * the operator AND counted as protocol drift.
 *
 * Field order and fallbacks were copied from the legacy Rust adapter's
 * `build_permission_denied_notice` (`src-tauri/src/pipeline/adapter/labels.rs`,
 * retired 2026-09-21 per ADR-0015 — read it at `944b9d6` or earlier), so this
 * module and that surface described the same event with the same words instead
 * of drifting into two vocabularies. That surface is gone; this is now the
 * only implementation, and the copy is the record of what it was aligned to.
 */

export interface SystemNotice {
	severity: "info" | "warning";
	label: string;
	body?: string;
}

/** A non-empty string field, or undefined — an empty string is not a reason. */
function stringField(
	event: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = event[key];
	if (typeof value !== "string" || !value.trim()) return undefined;
	return value;
}

function firstOf(...values: (string | undefined)[]): string | undefined {
	for (const value of values) {
		if (value !== undefined) return value;
	}
	return undefined;
}

/**
 * The visible notice for a system event, or null when the event is not one of
 * the operator-facing kinds. Never throws: every field is optional on the wire,
 * and a denial with no fields at all still has to produce a label.
 */
export function noticeFromSystemEvent(
	event: Record<string, unknown>,
): SystemNotice | null {
	if (event.subtype !== "permission_denied") return null;
	const toolName = stringField(event, "tool_name");
	const reasonType = stringField(event, "decision_reason_type");
	return {
		severity: "warning",
		label: toolName ? `Permission denied for ${toolName}` : "Permission denied",
		body: firstOf(
			stringField(event, "decision_reason"),
			stringField(event, "message"),
			reasonType ? `Decision: ${reasonType}` : undefined,
		),
	};
}
