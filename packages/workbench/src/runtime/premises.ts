import type { Blackboard } from "../blackboard";

import { noticeIdForClaims } from "./notice-id";
import { inspectWriterPremises } from "./premise-check";
import { emptyPassCounts, PREMISE_PASS_EVENT } from "./premise-counts";

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

/** Current stale inputs, including already delivered ones; no writes or active-window cutoff. */
export async function currentPremiseNotices(
	bb: Blackboard,
	writerId?: string,
): Promise<StalePremiseNotice[]> {
	const writers = writerId
		? [await bb.sessions.get(writerId)].filter((writer) => writer !== null)
		: await bb.sessions.list();
	const notices: StalePremiseNotice[] = [];
	for (const writer of writers) {
		if (writer.kind !== "agent" && writer.kind !== "human") continue;
		const { stale } = await inspectWriterPremises(bb, writer.id);
		if (!stale.length) continue;
		notices.push({
			writerId: writer.id,
			writerKind: writer.kind,
			stale,
			noticeId: noticeIdForClaims(writer.id, stale),
			message: formatNotice(stale.length),
		});
	}
	return notices;
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
		const checked = await inspectWriterPremises(bb, writer.id);
		for (const key of Object.keys(counts) as Array<keyof typeof counts>) {
			counts[key] += checked.counts[key];
		}
		const evidence = checked.stale.filter((claim) => {
			if (!reported.has(staleKey(writer.id, claim))) return true;
			counts.suppressedDedup += 1;
			counts.notified -= 1;
			return false;
		});
		if (evidence.length === 0) continue;
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
