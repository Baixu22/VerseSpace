import type { Blackboard } from "../blackboard";
import { hashPathClaim } from "../blackboard/footprint";
import type { FootprintUsed } from "../blackboard/sessions";

import { noticeIdForClaims } from "./notice-id";
import { emptyPassCounts, PREMISE_PASS_EVENT } from "./premise-counts";

import { diffFor } from "./premise-diff";
import { spanInvalidated, surfaceUnchanged } from "./premise-predicate";

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

export function staleKey(
	writerId: string,
	claim: Pick<StalePremiseClaim, "path" | "currentVersion">,
): string {
	return `${writerId}|${claim.path}|${claim.currentVersion ?? ""}`;
}

export async function reportedStaleKeys(bb: Blackboard): Promise<Set<string>> {
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
		// body changes matter). Explicit content reads already carry a span
		// (including 1..EOF for whole reads) and must also observe body changes.
		// Remaining claims use the dependency/surface heuristic. Asking the
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

export { diffFor, parseHunks } from "./premise-diff";

export { spanInvalidated } from "./premise-predicate";
