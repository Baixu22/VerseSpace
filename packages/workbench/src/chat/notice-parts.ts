import type { NoticePart } from "./thread-types";

/**
 * The premise notices folded into a user turn, as transcript parts. The first
 * line of a rendered notice is its headline (`前提失效：N 个文件…`); the rest
 * is the per-file detail. Keeping them on the user message records what the
 * model was told alongside what the user asked.
 */
export function noticeParts(notices: readonly string[]): NoticePart[] {
	const parts: NoticePart[] = [];
	for (const notice of notices) {
		const trimmed = notice.trim();
		if (!trimmed) continue;
		const newline = trimmed.indexOf("\n");
		const label = newline === -1 ? trimmed : trimmed.slice(0, newline).trim();
		const body = newline === -1 ? "" : trimmed.slice(newline + 1).trim();
		parts.push({
			type: "notice",
			severity: "warning",
			label,
			...(body ? { body } : {}),
		});
	}
	return parts;
}
