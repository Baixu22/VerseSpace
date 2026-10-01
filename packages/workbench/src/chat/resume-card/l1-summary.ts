/**
 * 分支 L1 结构摘要（TF-0197，恢复 TF-0132 的摘要构想）。
 *
 * 恢复卡上的「分支动静」行从单句（R10）升级为逐字段的结构摘要：账本差 ·
 * 写集(N 文件, hash) · 接口 Δ · merge-guard 预测 · Verifier 状态 · 失效前提数。
 * 三条硬规则写在实现里：
 *
 * 1. 每行事实都带 refs（事件 id / eventSeq / 账本条目 / 接口键）——没有溯源的
 *    句子不许出现在摘要里；
 * 2. R3 措辞互斥：「未经 Verifier」与 checkpoint id 不同时出现——引用了
 *    checkpoint 就说明 Verifier 管道知道它，措辞必须换成「无验证结论」；
 * 3. 验证历史、当前有效性与当前可观测前提分开展示；历史检测事件不计为
 *    当前失效文件，失败/超时与缺失绑定都不能写成当前已验证。
 *
 * 摘要是只读投影：builder 不写任何事件、不改任何状态。空分支零痕迹——
 * 没有边界后活动的分支产出零行，调用方据此不建恢复卡行。
 */

import { listArtifactReviews } from "../../artifacts/status";
import type { Blackboard } from "../../blackboard";
import { claimVersion } from "../../blackboard/claim-version";
import { currentPremiseNotices } from "../../runtime/premises";
import { checkpointVerificationStatus } from "../../runtime/verification-status";
import type { WorkbenchEvent } from "../../types/event";

const normalize = (path: string) => path.replace(/\\/g, "/");
const compact = (text: string) =>
	text.length > 60 ? `${text.slice(0, 59)}…` : text;
const shortHash = (hash: string | null | undefined) =>
	hash ? hash.slice(0, 8) : "?";

export type L1LineKind =
	| "ledger"
	| "writes"
	| "interfaces"
	| "merge"
	| "verifier"
	| "premises";

export interface L1SummaryLine {
	kind: L1LineKind;
	text: string;
	refs: string[];
}

export interface BranchL1Summary {
	threadId: string;
	title: string;
	lines: L1SummaryLine[];
}

/** 渲染为多行文本（一行一条事实）；空分支渲染为空串。 */
export function renderL1Summary(summary: BranchL1Summary): string {
	return summary.lines.map((line) => line.text).join("\n");
}

/** 全部行的 refs 并集——渲染面（FactRow.refs）的可追溯性以此为断言基准。 */
export function l1SummaryRefs(summary: BranchL1Summary): string[] {
	return [...new Set(summary.lines.flatMap((line) => line.refs))];
}

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

interface WriteClaim {
	path: string;
	version: string | null;
	/** 携带这条写claim的账本条目 ref。 */
	ref: string;
}

function listWrites(writes: WriteClaim[]): string {
	return writes
		.slice(0, 3)
		.map((write) => `${compact(write.path)}@${shortHash(write.version)}`)
		.join("、");
}

/**
 * 为一个分支线程构建 L1 结构摘要。`isAfterLeave` 由调用方按恢复基线提供
 * （eventSeq 优先、回退按事件序），保证摘要与恢复卡的其它事实共用同一
 * 条时间边界。
 */
export async function buildBranchL1Summary(input: {
	bb: Blackboard;
	branch: { id: string; title: string };
	isAfterLeave: (event: WorkbenchEvent, index: number) => boolean;
	events: WorkbenchEvent[];
	/** 当前线程在同一边界后的写集路径——merge-guard 预测的对照面。 */
	counterpartyWrites: Set<string>;
}): Promise<BranchL1Summary> {
	const { bb, branch, isAfterLeave, events, counterpartyWrites } = input;
	const summary: BranchL1Summary = {
		threadId: branch.id,
		title: branch.title,
		lines: [],
	};

	// ── 账本差 + 写集：边界后该分支的足迹条目 ──
	const ledgerRefs: string[] = [];
	const writeRefs = new Map<string, string>();
	const writes: WriteClaim[] = [];
	for (const [index, event] of events.entries()) {
		if (event.type !== "footprint" || !isAfterLeave(event, index)) continue;
		const payload = payloadOf(event);
		if (payload.writer !== branch.id) continue;
		const ref = eventRef(event);
		if (!ref) continue;
		ledgerRefs.push(ref);
		const generated = Array.isArray(payload.generated) ? payload.generated : [];
		for (const claim of generated) {
			if (!claim || typeof claim.path !== "string") continue;
			const path = normalize(claim.path);
			writes.push({
				path,
				version: typeof claim.version === "string" ? claim.version : null,
				ref,
			});
			writeRefs.set(path, ref);
		}
	}
	if (ledgerRefs.length > 0) {
		summary.lines.push({
			kind: "ledger",
			text: `账本新增 ${ledgerRefs.length} 条足迹`,
			refs: ledgerRefs,
		});
	}
	if (writes.length > 0) {
		summary.lines.push({
			kind: "writes",
			text: `写集 ${writes.length} 文件：${listWrites(writes)}`,
			refs: [...new Set(writes.map((write) => write.ref))],
		});
	}

	// ── 接口 Δ：写的路径撞上了注册接口，且内容 hash 与注册版本不一致 ──
	const writtenByPath = new Map(writes.map((write) => [write.path, write]));
	const interfaceEntries = (await bb.interfaces.list()).filter((entry) =>
		writtenByPath.has(normalize(entry.canonicalPath)),
	);
	const interfaceDelta = interfaceEntries.filter((entry) => {
		const write = writtenByPath.get(normalize(entry.canonicalPath));
		return write?.version != null && write.version !== entry.contentHash;
	});
	if (interfaceDelta.length > 0) {
		summary.lines.push({
			kind: "interfaces",
			text: `接口 Δ ${interfaceDelta.length} 项：${interfaceDelta
				.slice(0, 3)
				.map((entry) => `${entry.key}(${compact(entry.canonicalPath)})`)
				.join("、")}`,
			refs: [
				...interfaceDelta.map((entry) => `iface:${entry.key}`),
				...interfaceDelta.flatMap((entry) => {
					const write = writtenByPath.get(normalize(entry.canonicalPath));
					return write ? [write.ref] : [];
				}),
			],
		});
	}

	// ── merge-guard 预测：线程无独立 git 分支，预测取 merge-guard 的
	// 写集重叠臂——双方边界后都写过的文件就是冲突面（零启发式）。 ──
	const overlap = [...new Set(writes.map((write) => write.path))].filter(
		(path) => counterpartyWrites.has(path),
	);
	if (overlap.length > 0) {
		summary.lines.push({
			kind: "merge",
			text: `merge-guard 预测：与本线程写集重叠 ${overlap.length} 文件：${overlap
				.slice(0, 3)
				.map(compact)
				.join("、")}`,
			refs: [
				...new Set(
					overlap.flatMap((path) => {
						const ref = writeRefs.get(path);
						return ref ? [ref] : [];
					}),
				),
			],
		});
	}

	// ── Verifier 状态 + 失效前提数 ──
	const historical = events.filter(
		(event) =>
			event.type === "premise_stale" && payloadOf(event).writer === branch.id,
	);
	const [writer, readView, footprint] = await Promise.all([
		bb.sessions.get(branch.id),
		bb.sessions.readSetView(branch.id),
		bb.sessions.footprint(branch.id),
	]);
	const observations = [...readView.readFragments.values()].flat();
	const observedSeqs = new Set(observations.map((read) => read.seq));
	const comparable = observations.some((read) => claimVersion(read) != null);
	const current =
		writer && comparable ? await currentPremiseNotices(bb, branch.id) : [];
	const premiseCount = current.reduce(
		(sum, notice) => sum + notice.stale.length,
		0,
	);
	const premiseText =
		(writer && comparable
			? `当前观测到 ${premiseCount} 个失效文件（仅限可比读取）`
			: "当前读取前提覆盖未知") +
		(historical.length ? `；历史检测记录 ${historical.length} 条` : "");
	const premiseRefs = [
		...new Set([
			...historical.flatMap((event) => {
				const ref = eventRef(event);
				return ref ? [ref] : [];
			}),
			...footprint
				.filter((line) => observedSeqs.has(line.seq))
				.map((line) =>
					line.eventId
						? `footprint:${line.eventId}`
						: `footprintSeq:${line.seq}`,
				),
		]),
	];

	const checkpoints = (
		await Promise.all([
			bb.checkpoints.scanZone("staging"),
			bb.checkpoints.scanZone("verified"),
			bb.checkpoints.scanZone("failed"),
		])
	).flat();
	const linked = checkpoints
		.filter((checkpoint) => checkpoint.threadId === branch.id)
		.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
	const latest = linked[0];

	if (latest) {
		// 引用了 checkpoint 就不能说「未经 Verifier」（R3 互斥）。
		const status = await checkpointVerificationStatus(bb, latest);
		const verifierText = `checkpoint ${latest.id}：${status.message}`;
		summary.lines.push({
			kind: "verifier",
			text: `${verifierText}；${premiseText}`,
			refs: [latest.id, ...premiseRefs],
		});
	} else if (summary.lines.length > 0) {
		// 没有任何 checkpoint 才允许「未经 Verifier」，且只在分支确有活动时
		// 出现——空分支零痕迹。refs 溯源到未经它验证的那些账本事实。
		summary.lines.push({
			kind: "verifier",
			text: "未经 Verifier",
			refs: [...ledgerRefs],
		});
		if (premiseCount > 0 || historical.length > 0) {
			summary.lines.push({
				kind: "premises",
				text: premiseText,
				refs: premiseRefs,
			});
		}
	}

	for (const artifact of await listArtifactReviews(bb, branch.id)) {
		summary.lines.push({
			kind: "verifier",
			text: `产物 ${artifact.path}：${artifact.status}；${artifact.reason}；checkpoint revalidate ${artifact.checkpointId}`,
			refs: artifact.refs,
		});
	}
	return summary;
}
