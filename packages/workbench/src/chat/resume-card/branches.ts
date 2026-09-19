import type { Blackboard } from "../../blackboard";
import type { ReadSetDiff } from "../../runtime/read-set-diff";
import type { WorkbenchEvent } from "../../types/event";
import type { ThreadMeta } from "../threads";
import { resumeCardCircuit } from "./circuit";
import {
	buildBranchL1Summary,
	l1SummaryRefs,
	renderL1Summary,
} from "./l1-summary";
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
 *
 * TF-0197: the row's summary is now the branch's L1 structural summary
 * (账本差 · 写集 · 接口 Δ · merge-guard 预测 · Verifier 状态 · 失效前提数),
 * every line traced by refs. Row-firing semantics are unchanged — a branch
 * still only surfaces when its post-leave writes touch this thread's stale
 * reads.
 *
 * TF-0198 noise gates: when the dismissal circuit is open (recent dismiss
 * rate >50%), rows degrade to L0 pointers — one factual line per branch,
 * lineage ref and 查看分支 link kept, no L1 detail. The ≥3-rows render merge
 * lives in the card builder (buildResumeCard).
 */
export async function branchResumeFacts(input: {
	bb: Blackboard;
	threadId: string;
	threads: Pick<ThreadMeta, "id" | "title" | "forkOf">[];
	diff: ReadSetDiff;
	events: WorkbenchEvent[];
}): Promise<FactRow[]> {
	const { bb, threadId, threads, diff, events } = input;
	if (
		diff.status !== "available" ||
		!diff.baseline ||
		diff.stale.length === 0
	) {
		return [];
	}
	// 熔断器与 stats 共用同一投影读法；open 时本轮直接产 L0 指针行。
	const circuit = resumeCardCircuit(events);
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
	// merge-guard 预测的对照面：本线程在同一边界之后的写集。
	const counterpartyWrites = new Set<string>();
	for (const [index, event] of events.entries()) {
		if (event.type !== "footprint" || !afterLeave(event, index)) continue;
		const payload = payloadOf(event);
		if (payload.writer !== threadId || !Array.isArray(payload.generated)) {
			continue;
		}
		for (const claim of payload.generated) {
			if (claim && typeof claim.path === "string") {
				counterpartyWrites.add(normalize(claim.path));
			}
		}
	}
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
		const branchField = {
			threadId: branch.id,
			anchorMessageId: branch.forkOf!.anchorMessageId,
			paths: written,
			newForks,
		};
		if (circuit.state === "open") {
			// L0 指针行：一行事实 + 溯源 + 查看分支链接；不读接口表与
			// checkpoint——降级同时省掉 L1 的两个投影读。
			rows.push({
				path: `分支 · ${compact(branch.title)}`,
				summary: `自 #${branch.forkOf!.anchorMessageId.slice(0, 12)} 分出，写了 ${paths.size} 个你将读的文件${newForks > 0 ? `，${newForks} 个新分叉` : ""}`,
				refs: [...refs],
				writerId: branch.id,
				writerLabel: branch.title,
				source: "branch",
				annotation: { rule: "R10", label: "相关前提已变，查看分支与文件证据" },
				branch: branchField,
			});
			continue;
		}
		const l1 = await buildBranchL1Summary({
			bb,
			branch: { id: branch.id, title: branch.title },
			isAfterLeave: afterLeave,
			events,
			counterpartyWrites,
		});
		// 空分支零痕迹：没有边界后活动的分支不产出行（本投影只读，不落事件）。
		if (l1.lines.length === 0) continue;
		rows.push({
			path: `分支 · ${compact(branch.title)}`,
			summary: renderL1Summary(l1),
			refs: [...new Set([...refs, ...l1SummaryRefs(l1)])],
			writerId: branch.id,
			writerLabel: branch.title,
			source: "branch",
			annotation: { rule: "R10", label: "相关前提已变，查看分支与文件证据" },
			branch: branchField,
		});
	}
	return rows;
}
