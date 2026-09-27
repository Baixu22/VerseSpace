/**
 * Which paths does a codex approval request touch? (TF-0263 option A.)
 *
 * ADR-0017 recorded that approval params were not parsed "because no retained
 * fixture documents their shape". That left the codex write side outside the seal
 * entirely. To bring it in we have to read the params, so this module is
 * deliberately **pure and conservative**: it looks for path-bearing fields at a
 * bounded depth and for write redirections inside a command string, and it says
 * `unknown` rather than guessing when it finds nothing.
 *
 * `unknown` is not a pass. The caller must not pretend an unattributable approval
 * was guarded — see `answerServerRequest` in session.ts.
 *
 * 2026-09-27 (second reading): a native `fileChange` approval is the one case
 * where the params genuinely have no path to find — the real 0.158 params carry
 * only `threadId` / `turnId` / `itemId` / `startedAtMs` / `reason` / `grantRoot`.
 * The target is on the ITEM the approval names, so the caller may pass the paths
 * it already correlated from `params.itemId` (see `file-change-paths.ts`). This
 * stays pure: the third argument is caller-supplied, there is no module state.
 */

const APPROVAL_METHODS = new Set([
	"item/commandExecution/requestApproval",
	"item/fileChange/requestApproval",
	"item/fileRead/requestApproval",
]);

/**
 * Field names that carry a **file** path, anywhere in the params object.
 *
 * `cwd` is deliberately absent (measured 2026-09-27). It is the directory the
 * command runs *in*, not something being written; treating it as a target made
 * `session.ts` seal the project root itself, because
 * `normalizeTarget(projectRoot, projectRoot)` is `""` — every real
 * `commandExecution` approval therefore left an extra `seal.decided` event about
 * no file at all. The real 0.158 params do carry `cwd` (fixture:
 * `../fixtures/approvals/command-execution-0.158.json`); the write target is
 * still attributable from the command's redirect.
 */
const PATH_FIELDS = new Set([
	"path",
	"file",
	"filepath",
	"file_path",
	"target",
	"targetpath",
	"target_path",
	"abspath",
	"abs_path",
]);

/** A write redirection or a write verb inside a shell command. */
const WRITE_COMMAND =
	/(?:^|[^>])>>?\s*("[^"]+"|'[^']+'|[^\s|;&<>]+)|\btee\s+(?:-a\s+)?("[^"]+"|'[^']+'|[^\s|;&<>]+)/i;

export type ApprovalKind = "write" | "read" | "unknown";

export interface ApprovalTargets {
	/** False when the method is not an approval request at all. */
	isApproval: boolean;
	kind: ApprovalKind;
	/** Repo-relative or absolute paths the request appears to touch. */
	paths: string[];
}

function isApprovalMethod(method: string): boolean {
	return APPROVAL_METHODS.has(method);
}

function collectPaths(value: unknown, out: Set<string>, depth: number): void {
	if (depth > 4 || value === null || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const entry of value) collectPaths(entry, out, depth + 1);
		return;
	}
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (
			PATH_FIELDS.has(key.toLowerCase()) &&
			typeof entry === "string" &&
			entry
		) {
			out.add(entry);
			continue;
		}
		collectPaths(entry, out, depth + 1);
	}
}

function writeTargetsFromCommand(command: string): string[] {
	const found: string[] = [];
	for (const match of command.matchAll(new RegExp(WRITE_COMMAND, "gi"))) {
		const raw = match[1] ?? match[2];
		if (!raw) continue;
		const cleaned = raw.replace(/^["']|["']$/g, "");
		// Skip obvious non-paths (e.g. `> /dev/null`).
		if (!cleaned || cleaned.startsWith("&")) continue;
		found.push(cleaned);
	}
	return found;
}

export function approvalTargets(
	method: string,
	params: unknown,
	/**
	 * Paths the caller already correlated from the item this approval names
	 * (`params.itemId`). Only consulted for `item/fileChange/requestApproval`,
	 * the one method the evidence shows carries no path of its own; the
	 * `commandExecution` shape is unchanged (ADR-0023).
	 */
	itemPaths: readonly string[] = [],
): ApprovalTargets {
	if (!isApprovalMethod(method)) {
		return { isApproval: false, kind: "unknown", paths: [] };
	}
	const paths = new Set<string>();
	collectPaths(params, paths, 0);
	const record = (params ?? {}) as Record<string, unknown>;
	const command = typeof record.command === "string" ? record.command : "";
	const fromCommand = writeTargetsFromCommand(command);
	for (const path of fromCommand) paths.add(path);

	if (method === "item/fileRead/requestApproval") {
		return { isApproval: true, kind: "read", paths: [...paths] };
	}
	if (method === "item/fileChange/requestApproval") {
		// Real 0.158 params carry no path (fixture: file-change-0.158.json); the
		// correlated item paths are the only attributable target.
		for (const path of itemPaths) if (path) paths.add(path);
		return { isApproval: true, kind: "write", paths: [...paths] };
	}
	// commandExecution: only a write if the command actually redirects somewhere.
	return {
		isApproval: true,
		kind: fromCommand.length > 0 ? "write" : "unknown",
		paths: [...paths],
	};
}
