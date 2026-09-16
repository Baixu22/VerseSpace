import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { Blackboard } from "../blackboard";

import {
	type FootprintUsed,
	legacyWriterSpoolDir,
	writerSpoolDir,
} from "../blackboard/sessions";
import { pathExists } from "../fs/atomic";

export const execFileAsync = promisify(execFile);

export function spoolDirs(bb: Blackboard, writerId: string): string[] {
	return [
		...new Set([
			writerSpoolDir(bb.paths, writerId),
			legacyWriterSpoolDir(bb.paths, writerId),
		]),
	];
}

export async function resolveSpoolPath(
	bb: Blackboard,
	writerId: string,
	spoolName: string,
): Promise<string | undefined> {
	for (const dir of spoolDirs(bb, writerId)) {
		const candidate = join(dir, spoolName);
		if (await pathExists(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

export async function findSpool(
	bb: Blackboard,
	writerId: string,
	path: string,
): Promise<string | undefined> {
	const safeName = path
		.replace(/\\/g, "/")
		.replace(/[^A-Za-z0-9._-]/g, "_")
		.slice(-80);
	const candidates: string[] = [];
	for (const dir of spoolDirs(bb, writerId)) {
		try {
			for (const name of await readdir(dir)) {
				if (name.endsWith(`-${safeName}`)) {
					candidates.push(name);
				}
			}
		} catch {
			// A missing legacy or canonical spool is a normal downgrade path.
		}
	}
	return candidates.sort().at(-1);
}

export async function diffFor(
	bb: Blackboard,
	writerId: string,
	claim: FootprintUsed,
): Promise<string | undefined> {
	const spoolName = claim.spool ?? (await findSpool(bb, writerId, claim.path));
	if (!spoolName) {
		return undefined;
	}
	const spoolFile = await resolveSpoolPath(bb, writerId, spoolName);
	if (!spoolFile) {
		return undefined;
	}
	const current = isAbsolute(claim.path)
		? claim.path
		: join(bb.projectRoot, claim.path);
	try {
		const { stdout } = await execFileAsync(
			"git",
			// -U0: exact old/new ranges. Layer 2 relocates read spans from
			// these hunk headers, and context lines would make the predicate
			// over-inclusive — erring toward recall, not precision.
			["diff", "--no-index", "-U0", "--", spoolFile, current],
			{ maxBuffer: 1024 * 1024 },
		);
		return stdout.trim() ? stdout : undefined;
	} catch (error) {
		// git diff --no-index exits 1 when files differ — the diff IS the stdout
		const err = error as { stdout?: string };
		if (typeof err.stdout === "string" && err.stdout.trim()) {
			return err.stdout;
		}
		return undefined;
	}
}

export interface DiffHunk {
	/** 1-based first line of the old range. */
	oldStart: number;
	/** Number of lines in the old range (0 for a pure insertion). */
	oldCount: number;
	newCount: number;
}

export const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseHunks(diff: string): DiffHunk[] {
	const hunks: DiffHunk[] = [];
	for (const line of diff.split("\n")) {
		const match = HUNK_RE.exec(line);
		if (!match) {
			continue;
		}
		hunks.push({
			oldStart: Number(match[1]),
			oldCount: match[2] === undefined ? 1 : Number(match[2]),
			newCount: match[4] === undefined ? 1 : Number(match[4]),
		});
	}
	return hunks;
}

export function oldEndOf(hunk: DiffHunk): number {
	// In a zero-context diff, -N,0 inserts AFTER old line N. Keep that
	// boundary for relocation; treating it as N-1 shifts a read too early.
	return hunk.oldStart + Math.max(1, hunk.oldCount) - 1;
}
