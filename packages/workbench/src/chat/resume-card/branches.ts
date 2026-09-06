import type { ReadSetDiff } from "../../runtime/read-set-diff";
import type { WorkbenchEvent } from "../../types/event";
import type { ThreadMeta } from "../threads";
import type { FactRow } from "./types";

const normalize = (path: string) => path.replace(/\\/g, "/");
const compact = (text: string) =>
	text.length > 80 ? `${text.slice(0, 79)}…` : text;

function payloadOf(event: WorkbenchEvent): Record<string, unknown> {
	return event.payload && typeof event.payload === "object"
		? (event.payload as Record<string, unknown>)
		: {};
}

function eventRef(event: WorkbenchEvent): string | null {
	return (
		event.id ?? (event.eventSeq == null ? null : `eventSeq:${event.eventSeq}`)
	);
}

/**
 * Card rule R10 (TF-0151), distinct from the product's no-orchestrator R10.
 * A read-only join: fork lineage + post-leave writes + currently stale reads.
 * Forking alone never creates a row, and no verifier verdict is inferred.
 */
export function branchResumeFacts(input: {
	threadId: string;
	threads: Pick<ThreadMeta, "id" | "title" | "forkOf">[];
	diff: ReadSetDiff;
	events: WorkbenchEvent[];
}): FactRow[] {
	const { threadId, threads, diff, events } = input;
	if (
		diff.status !== "available" ||
		!diff.baseline ||
		diff.stale.length === 0
	) {
		return [];
	}
	const boundary = diff.baseline;
	const leaveIndex = boundary.eventId
		? events.findIndex((event) => event.id === boundary.eventId)
		: -1;
	const afterLeave = (event: WorkbenchEvent, index: number) =>
		boundary.eventSeq !== null && event.eventSeq !== undefined
			? event.eventSeq > boundary.eventSeq
			: leaveIndex >= 0 && index > leaveIndex;
	const parentId = threads.find((thread) => thread.id === threadId)?.forkOf
		?.sourceThreadId;
	const branches = threads.filter(
		(thread) =>
			thread.id !== threadId &&
			thread.forkOf &&
			(thread.forkOf.sourceThreadId === threadId ||
				(parentId && thread.forkOf.sourceThreadId === parentId)),
	);
	const staleByPath = new Map(
		diff.stale.map((fact) => [normalize(fact.path), fact]),
	);
	const rows: FactRow[] = [];
	for (const branch of branches) {
		const lineage = events.find((event) => {
			const payload = payloadOf(event);
			return (
				event.type === "thread.forked" &&
				payload.threadId === branch.id &&
				payload.sourceThreadId === branch.forkOf!.sourceThreadId
			);
		});
		const lineageRef = lineage && eventRef(lineage);
		if (!lineageRef) continue;
		const refs = new Set([lineageRef]);
		const paths = new Set<string>();
		let newForks = 0;
		for (const [index, event] of events.entries()) {
			if (!afterLeave(event, index)) continue;
			const payload = payloadOf(event);
			const ref = eventRef(event);
			if (!ref) continue;
			// Only fork decisions have a durable event boundary. Do not claim
			// that an unobserved variant/reload is absent from the whole ledger.
			if (
				event.type === "thread.forked" &&
				payload.sourceThreadId === branch.id
			) {
				newForks += 1;
				refs.add(ref);
			}
			if (
				event.type !== "footprint" ||
				payload.writer !== branch.id ||
				!Array.isArray(payload.generated)
			)
				continue;
			for (const claim of payload.generated) {
				if (!claim || typeof claim.path !== "string") continue;
				const path = normalize(claim.path);
				const stale = staleByPath.get(path);
				if (!stale) continue;
				paths.add(path);
				refs.add(ref);
				for (const evidence of stale.refs) refs.add(evidence);
			}
		}
		if (paths.size === 0) continue;
		for (const [index, event] of events.entries()) {
			const payload = payloadOf(event);
			if (
				event.type !== "premise_stale" ||
				payload.writer !== threadId ||
				!afterLeave(event, index)
			)
				continue;
			if (
				!Array.isArray(payload.stale) ||
				!payload.stale.some(
					(claim) =>
						claim &&
						typeof claim.path === "string" &&
						paths.has(normalize(claim.path)),
				)
			)
				continue;
			const ref = eventRef(event);
			if (ref) refs.add(ref);
		}
		const written = [...paths].sort();
		const preview = written.slice(0, 3).map(compact).join("、");
		const remaining =
			written.length > 3 ? `，及另 ${written.length - 3} 个` : "";
		rows.push({
			path: `分支 · ${compact(branch.title)}`,
			summary: `离开后改动读集中的 ${written.length} 个文件：${preview}${remaining}；账本新增分叉记录 ${newForks} 条`,
			refs: [...refs],
			writerId: branch.id,
			writerLabel: branch.title,
			source: "branch",
			annotation: { rule: "R10", label: "相关前提已变，查看分支与文件证据" },
			branch: {
				threadId: branch.id,
				anchorMessageId: branch.forkOf!.anchorMessageId,
				paths: written,
				newForks,
			},
		});
	}
	return rows;
}
