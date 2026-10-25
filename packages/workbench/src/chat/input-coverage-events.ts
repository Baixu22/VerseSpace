import type { InputCoverageTracker } from "../blackboard/input-coverage";
import { asRecord, contentBlocks } from "./claude-render-blocks";

/** Shell tools are candidate events; unknown command paths stay in the denominator. */
const INPUT_TOOLS = new Set([
	"Read",
	"Grep",
	"Glob",
	"LS",
	"Bash",
	"PowerShell",
]);
export function observeClaudeCandidates(
	tracker: InputCoverageTracker,
	event: Record<string, unknown>,
) {
	if (event.type !== "assistant") return;
	for (const raw of contentBlocks(event)) {
		const block = asRecord(raw);
		if (block?.type === "tool_use" && INPUT_TOOLS.has(String(block.name)))
			tracker.begin(String(block.id ?? "act-unknown"));
	}
}
export function observeCodexCandidates(
	tracker: InputCoverageTracker,
	event: Record<string, unknown>,
) {
	const item = asRecord(event.item);
	if (
		(event.type === "item/started" || event.type === "item/completed") &&
		item?.type === "commandExecution"
	)
		tracker.begin(String(item.id ?? "act-unknown"));
}
