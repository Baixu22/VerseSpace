import type { Blackboard } from "../../blackboard";
import { git } from "../../git";

/** Distinct authors of the last `limit` commits touching `path`. */
export async function recentAuthors(
	projectRoot: string,
	path: string,
	limit = 50,
): Promise<string[]> {
	const result = await git(
		["log", `--format=%an`, "-n", String(limit), "--", path],
		projectRoot,
	);
	if (!result.ok) {
		return []; // no history (untracked file) is not an error condition
	}
	const authors = result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	return [...new Set(authors)];
}

/** Files more than one writer has written to inside the window. */
export async function overlappingWrites(
	bb: Blackboard,
	windowMs = 30 * 60_000,
): Promise<Array<{ a: string; b: string; paths: string[] }>> {
	const cutoff = Date.now() - windowMs;
	const writers = await bb.sessions.list();
	const recent = new Map<string, Set<string>>();
	for (const writer of writers) {
		const { writes } = await bb.sessions.readSetView(writer.id);
		const paths = new Set(
			writes
				.filter((write) => Date.parse(write.ts) >= cutoff)
				.map((write) => write.path),
		);
		if (paths.size > 0) {
			recent.set(writer.id, paths);
		}
	}
	const ids = [...recent.keys()];
	const overlaps: Array<{ a: string; b: string; paths: string[] }> = [];
	for (let i = 0; i < ids.length; i += 1) {
		for (let j = i + 1; j < ids.length; j += 1) {
			const a = ids[i]!;
			const b = ids[j]!;
			const shared = [...recent.get(a)!].filter((path) =>
				recent.get(b)!.has(path),
			);
			if (shared.length > 0) {
				overlaps.push({ a, b, paths: shared.sort() });
			}
		}
	}
	return overlaps;
}
