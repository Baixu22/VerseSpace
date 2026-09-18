import { git } from "./index";

/**
 * Whether this git can answer a *real* merge question.
 *
 * Only `merge-tree --write-tree` performs an actual merge, and only that form
 * is free of heuristics. Older gits answer with a completely different shape
 * (`<mode> <oid> <stage>\t<path>` lines) whose first line is *also* a tree oid,
 * so the output cannot be trusted to identify itself. We therefore ask once,
 * up front, instead of assuming and mis-reading whatever comes back.
 */
export type MergeTreeSupport =
	| { kind: "supported" }
	| { kind: "unsupported"; reason: string };

/**
 * Probe by running `merge-tree --write-tree` with no operands: git replies
 * with its usage text, and whether that text mentions `--write-tree` is the
 * answer. Operand-free, so the result does not depend on the repo's state.
 */
export async function probeMergeTree(
	projectRoot: string,
): Promise<MergeTreeSupport> {
	const result = await git(["merge-tree", "--write-tree"], projectRoot);
	const combined = `${result.stdout}${result.stderr}`;
	if (combined.includes("--write-tree")) {
		return { kind: "supported" };
	}
	const firstLine = result.stderr.trim().split("\n")[0]?.trim() ?? "";
	return {
		kind: "unsupported",
		reason:
			firstLine.length > 0
				? firstLine
				: "这个 git 不认识 merge-tree --write-tree，做不了真实合并预检",
	};
}

/** A tree oid as printed by `merge-tree --write-tree`. */
const TREE_OID = /^[0-9a-f]{40,64}$/;

/**
 * Fingerprint of the *trivial* merge-tree format (`<mode> <oid> <stage>\t<path>`).
 * The probe keeps us off that code path, but if such a line ever reaches us it
 * must not be mistaken for a conflict path — that would report git's internal
 * object ids as filenames.
 */
const TRIVIAL_LINE = /^\d{6} [0-9a-f]{40,64} \d\t/;

/**
 * Parse a `merge-tree --write-tree --name-only` payload: tree oid, then the
 * conflicting paths, then a blank line and the informational messages.
 *
 * Returns `null` when the output is not a shape we recognise. That is the
 * point of the function: "we don't know" must stay distinguishable from
 * "no conflicts", or the caller will publish a clean bill of health it never
 * received.
 */
export function parseMergeTreeOutput(stdout: string): string[] | null {
	const lines = stdout.split("\n");
	const head = (lines[0] ?? "").trim();
	if (!TREE_OID.test(head)) {
		return null;
	}
	const paths: string[] = [];
	for (const line of lines.slice(1)) {
		const trimmed = line.trim();
		if (trimmed === "") {
			break; // end of the name-only section
		}
		if (
			trimmed.startsWith("Auto-merging") ||
			trimmed.startsWith("CONFLICT") ||
			trimmed.startsWith("error:")
		) {
			break;
		}
		if (TRIVIAL_LINE.test(trimmed)) {
			return null;
		}
		paths.push(trimmed);
	}
	return paths;
}
