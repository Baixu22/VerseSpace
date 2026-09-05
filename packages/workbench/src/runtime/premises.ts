import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { Blackboard } from "../blackboard";
import { hashPathClaim } from "../blackboard/footprint";
import {
	type FootprintUsed,
	legacyWriterSpoolDir,
	type ReadSpan,
	writerSpoolDir,
} from "../blackboard/sessions";
import { pathExists } from "../fs/atomic";
import { noticeIdForClaims } from "./notice-id";
import { emptyPassCounts, PREMISE_PASS_EVENT } from "./premise-counts";
import { surfaceHash } from "./surface";

/**
 * Premise reconciliation (R2): compare every writer's recorded read-set
 * against the disk's current state. A claim whose content moved since the
 * writer observed it is a stale premise — the writer is building on facts
 * that no longer hold. Advisory only: the runtime notifies (advice), the
 * writer's LLM decides whether its plan is actually invalidated and patches
 * just the affected steps (ADR-0006).
 *
 * Precision posture: 往精度错，不往召回错 — a false positive costs one
 * extra reasoning step, a miss is only caught downstream. Predicate layer 1
 * (durability) already removes generated/vendor noise here; layers 2-3
 * (span-scoped reads, export-surface hashes) tighten further.
 */

const execFileAsync = promisify(execFile);

export interface StalePremiseClaim {
	path: string;
	observedVersion: string | null;
	currentVersion: string | null;
	diff?: string;
}

export interface StalePremiseNotice {
	noticeId: string;
	writerId: string;
	writerKind: string;
	stale: StalePremiseClaim[];
	message: string;
}

/**
 * The notice wording lives here so detection (reconcile) and delivery
 * (drain) can never drift apart — a writer that gets two different phrasings
 * for the same fact will stop trusting either.
 */
export function formatNotice(count: number): string {
	return (
		`前提失效：你读过的 ${count} 个文件已被其他写者修改。` +
		"请核对 diff，判断是否真的推翻你的计划前提；只修补依赖失效值的那几步，不要整体重做。"
	);
}

export interface ReconcileOptions {
	/** Deliver a notice into a live writer's session (in-process only). */
	deliver?: (notice: StalePremiseNotice) => Promise<"delivered" | "queued">;
	/** Only check writers whose last activity is within this window. */
	activeWindowMs?: number;
}

function spoolDirs(bb: Blackboard, writerId: string): string[] {
	return [
		...new Set([
			writerSpoolDir(bb.paths, writerId),
			legacyWriterSpoolDir(bb.paths, writerId),
		]),
	];
}

async function resolveSpoolPath(
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

/** Newest spool snapshot of `path` within the writer's spool dir, if any. */
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

/** Unified diff between the read-time spool snapshot and the current file. */
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

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse `-U0` hunks out of a unified diff. Zero-context hunks are the whole
 * point: they give exact old/new ranges, which is what span relocation needs.
 */
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

function oldEndOf(hunk: DiffHunk): number {
	// a pure insertion has an empty old range that sits BEFORE oldStart
	return hunk.oldStart + hunk.oldCount - 1;
}

/** Layer 3 only applies where an export surface is a meaningful concept. */
const SURFACE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/**
 * R2 predicate layer 3 (TF-0076): a dependency read only cares about the
 * module's export surface — signatures, not bodies. Compare the surface of
 * the read-time spool against the surface on disk; unchanged surface means
 * the importer's premise still holds.
 *
 * Returns false (surface moved) whenever it cannot prove otherwise: no spool,
 * no surface to hash, or a non-JS/TS file. Silence is the expensive error
 * here, so decline rather than guess.
 */
async function surfaceUnchanged(
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

/**
 * R2 predicate layer 2 (TF-0075): decide whether a write to this file actually
 * touched the range the writer read.
 *
 * - A hunk overlapping the span means the read content moved → invalidated.
 * - Otherwise the span only shifted; relocate it by the accumulated delta and
 *   re-hash. Same hash means the edit landed elsewhere → no notice.
 * - Without a read-time snapshot we cannot compute hunks, so we fall back to
 *   layer 1 (whole-file) and report invalidated. Erring toward notifying is
 *   the right direction: a spurious notice costs one reasoning step.
 */
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
		if (hunk.oldStart <= span.end && span.start <= oldEndOf(hunk)) {
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

/** One notice per (writer, path, currentVersion) — cross-process dedup. */
function staleKey(
	writerId: string,
	claim: Pick<StalePremiseClaim, "path" | "currentVersion">,
): string {
	return `${writerId}|${claim.path}|${claim.currentVersion ?? ""}`;
}

async function reportedStaleKeys(bb: Blackboard): Promise<Set<string>> {
	const keys = new Set<string>();
	for (const event of await bb.events.query({ type: "premise_stale" })) {
		const payload = event.payload as
			| {
					writer?: string;
					stale?: Array<{ path: string; currentVersion: string | null }>;
			  }
			| undefined;
		if (!payload?.writer) {
			continue;
		}
		for (const claim of payload.stale ?? []) {
			keys.add(staleKey(payload.writer, claim));
		}
	}
	return keys;
}

/**
 * One reconciliation pass. Emits `premise_stale` events (with diff evidence
 * when a read-time spool snapshot exists) and hands notices to `deliver`;
 * writers that cannot be reached live keep the notice in the event log and
 * drain it on their next run. Returns the notices for the caller.
 *
 * Also records where every candidate claim died (TF-0149) as one
 * `premise_pass` event — see `premise-counts.ts` for the accounting rules.
 */
export async function reconcilePremises(
	bb: Blackboard,
	options: ReconcileOptions = {},
): Promise<StalePremiseNotice[]> {
	const activeWindowMs = options.activeWindowMs ?? 30 * 60_000;
	const cutoff = Date.now() - activeWindowMs;
	const notices: StalePremiseNotice[] = [];
	const counts = emptyPassCounts();
	// Snapshot once per pass instead of rereading the whole event log for every
	// candidate claim. A concurrent pass may still win the race; the next pass
	// converges and the durable key prevents ordinary repeat delivery.
	const reported = await reportedStaleKeys(bb);

	for (const writer of await bb.sessions.list()) {
		if (writer.kind !== "agent" && writer.kind !== "human") {
			continue;
		}
		const lastActive = Date.parse(writer.lastActiveAt);
		if (Number.isFinite(lastActive) && lastActive < cutoff) {
			continue; // the writer itself went quiet: nothing live to notify
		}
		counts.writers += 1;
		const { reads, writes } = await bb.sessions.readSetView(writer.id);
		// Layer 3's dependency/subject split, derived rather than declared: a
		// writer that also edits a file is working on it (subject-matter, so
		// body changes matter); a writer that only reads it is consuming its
		// surface (dependency, so only signature changes matter). Asking the
		// agent to declare which one it is would be the same tax the forest
		// refuses everywhere else.
		const touched = new Set(writes.map((write) => write.path));
		const stale: Array<
			StalePremiseClaim & { claim: FootprintUsed; diff?: string }
		> = [];
		for (const claim of reads.values()) {
			if (claim.durability === "durable") {
				counts.suppressedL1 += 1;
				continue; // predicate layer 1: durable reads never invalidate
			}
			const current = await hashPathClaim(bb.projectRoot, claim.path);
			if (current.version === claim.version) {
				continue; // content unchanged — premise still holds
			}
			// The read-set/write overlap the layers get to argue about. Counted
			// here, before any suppression, so `notified / overlaps` is a ratio
			// of decisions rather than of surviving decisions.
			counts.overlaps += 1;
			// predicate layer 2: the file moved, but did the part the writer
			// actually read move? Span claims need the diff to answer that.
			let diff: string | undefined;
			if (claim.span) {
				diff = await diffFor(bb, writer.id, claim);
				if (!(await spanInvalidated(bb, claim, claim.span, diff))) {
					counts.suppressedL2 += 1;
					continue; // the edit landed outside the read range
				}
			} else if (!touched.has(claim.path)) {
				// dependency read: only the export surface has to hold
				if (await surfaceUnchanged(bb, writer.id, claim)) {
					counts.suppressedL3 += 1;
					continue;
				}
			}
			const candidate: StalePremiseClaim = {
				path: claim.path,
				observedVersion: claim.version ?? null,
				currentVersion: current.version ?? null,
			};
			if (reported.has(staleKey(writer.id, candidate))) {
				counts.suppressedDedup += 1;
				continue;
			}
			stale.push({ ...candidate, claim, diff });
		}
		counts.notified += stale.length;
		if (stale.length === 0) {
			continue;
		}
		// diffs need a git subprocess: compute only for surviving claims
		const evidence: StalePremiseClaim[] = [];
		for (const { claim, diff, ...rest } of stale) {
			evidence.push({
				...rest,
				// span claims already have it; the rest pay one git call here
				diff: diff ?? (await diffFor(bb, writer.id, claim)),
			});
		}
		const notice: StalePremiseNotice = {
			noticeId: noticeIdForClaims(writer.id, evidence),
			writerId: writer.id,
			writerKind: writer.kind,
			stale: evidence,
			message: formatNotice(evidence.length),
		};
		await bb.events.append({
			timestamp: new Date().toISOString(),
			source: "runtime",
			type: "premise_stale",
			payload: {
				writer: writer.id,
				noticeId: notice.noticeId,
				stale: evidence,
			},
		});
		for (const claim of evidence) {
			reported.add(staleKey(writer.id, claim));
		}
		const outcome = (await options.deliver?.(notice)) ?? "queued";
		await bb.events.append({
			timestamp: new Date().toISOString(),
			source: "runtime",
			type: "premise_notice_outcome",
			// `stale` is what lets the drain path (and any later process) tell
			// WHICH notices already landed — outcome alone would re-deliver
			// everything on every pass.
			payload: {
				writer: writer.id,
				noticeId: notice.noticeId,
				outcome,
				stale: outcome === "delivered" ? evidence : [],
			},
		});
		notices.push(notice);
	}
	// A pass with no overlaps carries nothing the ratio can use, and the
	// watcher runs a pass on every file change — so silence stays silent.
	if (counts.overlaps > 0) {
		await bb.events.append({
			timestamp: new Date().toISOString(),
			source: "runtime",
			type: PREMISE_PASS_EVENT,
			payload: { ...counts },
		});
	}
	return notices;
}
