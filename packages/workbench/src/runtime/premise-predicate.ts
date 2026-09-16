import { isAbsolute, join } from "node:path";

import type { Blackboard } from "../blackboard";
import { hashPathClaim } from "../blackboard/footprint";
import type { FootprintUsed, ReadSpan } from "../blackboard/sessions";
import {
	findSpool,
	oldEndOf,
	parseHunks,
	resolveSpoolPath,
} from "./premise-diff";
import { surfaceHash } from "./surface";

export const SURFACE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

export async function surfaceUnchanged(
	bb: Blackboard,
	writerId: string,
	claim: FootprintUsed,
): Promise<boolean> {
	if (!SURFACE_EXTENSIONS.test(claim.path)) {
		return false;
	}
	const spoolName = claim.spool ?? (await findSpool(bb, writerId, claim.path));
	if (!spoolName) {
		return false; // no read-time snapshot: nothing to compare against
	}
	const { readFile } = await import("node:fs/promises");
	const spoolPath = await resolveSpoolPath(bb, writerId, spoolName);
	if (!spoolPath) {
		return false;
	}
	const currentPath = isAbsolute(claim.path)
		? claim.path
		: join(bb.projectRoot, claim.path);
	const [before, after] = await Promise.all([
		readFile(spoolPath, "utf8").catch(() => null),
		readFile(currentPath, "utf8").catch(() => null),
	]);
	if (before === null || after === null) {
		return false;
	}
	const beforeHash = surfaceHash(before);
	const afterHash = surfaceHash(after);
	return beforeHash !== null && beforeHash === afterHash;
}

export async function spanInvalidated(
	bb: Blackboard,
	claim: FootprintUsed,
	span: ReadSpan,
	diff: string | undefined,
): Promise<boolean> {
	if (diff === undefined) {
		return true;
	}
	const hunks = parseHunks(diff);
	if (hunks.length === 0) {
		return true; // diff exists but unparseable: don't guess
	}
	for (const hunk of hunks) {
		const overlaps =
			hunk.oldCount === 0
				? span.start <= hunk.oldStart && hunk.oldStart < span.end
				: hunk.oldStart <= span.end && span.start <= oldEndOf(hunk);
		if (overlaps) {
			return true;
		}
	}
	const shift = hunks
		.filter((hunk) => oldEndOf(hunk) < span.start)
		.reduce((sum, hunk) => sum + (hunk.newCount - hunk.oldCount), 0);
	const relocated = await hashPathClaim(bb.projectRoot, claim.path, undefined, {
		start: Math.max(1, span.start + shift),
		end: span.end + shift,
	});
	return relocated.span?.hash !== claim.span?.hash;
}
