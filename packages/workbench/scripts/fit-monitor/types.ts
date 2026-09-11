/**
 * TF-0135 / TF-0136 / TF-0137 · 数据监控的类型。
 *
 * 监控与账本的分工：账本回答「现在长什么样」，监控回答「和上一次比，哪一项
 * 变了、变的方向是不是坏」。所以样本是可比的快照（同一黑板的同一批读数），
 * 告警是两次快照之间的差分判断，两者都不写黑板——监控是观察者，不是写者。
 */

import type { LandmarkDenominator } from "../../src/interactions/landmark-set";
import type { MoatNumber, SampleWindow } from "../fit-ledger/ledger";
import type { EvidenceKind, Fit } from "../fit-ledger/metrics";
import type { VerdictStatus } from "../fit-ledger/verdicts";

export type Severity = "high" | "warn" | "info";

export interface MonitorSample {
	at: string;
	kind: "fit-monitor-sample";
	evidenceKind: EvidenceKind;
	workspace: string;
	blackboard: string;
	threads: number;
	writers: number;
	events: number;
	/** 事件跨度天数：只作长期观察记录，不设日历门（TF-0141）。 */
	days: number;
	t0Started: boolean;
	sampleWindow: SampleWindow;
	moat: MoatNumber[];
	gate: { open: boolean; missing: string[] };
	verdicts: Array<{ id: string; title: string; status: VerdictStatus }>;
	histogram: Record<Fit, number>;
	/** unknown 的构成：不拆开就没法判断「unknown 变多」是退步还是记账口径。 */
	unknown: {
		total: number;
		record: number;
		unbuilt: number;
		noSample: number;
		natural: number;
		ids: string[];
	};
	natural: {
		/** 这份读数用的分母口径（TF-0159 之后是 `session-top-k`）。 */
		denominator: LandmarkDenominator;
		topK: number;
		total: number;
		reviewed: number;
		endorsed: number;
		rejected: number;
		endorsedShare: number | null;
		reviewedCoverage: number | null;
		pending: number;
		/** 落在当前集合之外的旧结论条数（保留、不改判，口径漂移不是数据丢失）。 */
		legacyReviews: number;
		/** 被种类门排除的写者数（git/human）——它们不进分母也不进分子。 */
		gatedWriters: number;
	};
	/**
	 * 旧口径读数（DOI>10 的文件级集合）：双读数期并报一个周期。**分母为空的现场
	 * 它不是「0 分」而是「不可计算」**，所以判据/告警都改用 natural 那条新口径，
	 * 这一栏留着只是为了让口径切换带来的跳变可归因。
	 */
	threshold: {
		denominator: LandmarkDenominator;
		total: number;
		reviewed: number;
		endorsed: number;
		endorsedShare: number | null;
	};
	/**
	 * 相对选择的可计量性：有文件级触碰的会话中 top-K 非空的比例。分母为空的含义
	 * 因此从「还没轮到」变成「标定没打中」——`landmark-set-empty` 这条告警随之改判。
	 */
	coverage: {
		k: number;
		sessions: number;
		withSet: number;
		items: number;
		distinctHandles: number;
		share: number | null;
		gatedWriters: number;
	};
	/** 代理自审口径（不构成用户认可）：低 = 地标投影选错，不是「人没来」。 */
	steward: {
		total: number;
		reviewed: number;
		endorsed: number;
		rejected: number;
		endorsedShare: number | null;
		reviewedCoverage: number | null;
	};
	restoreToMessage: {
		samples: number;
		medianChangeRatio: number | null;
		exceeds20Percent: boolean | null;
	};
	dataQuality: { insufficientHistory: boolean; reasons: string[] };
	rounds: { total: number; ok: number; failed: number; lastAt: string | null };
	model: {
		calls: number;
		attempts: number;
		retryRate: number;
		outcomes: Record<string, number>;
		lastOutcomeAt: string | null;
	};
	/** 最近一次 docs/fit-ledger-*.md 快照与本样本的行级一致性。 */
	snapshot: {
		file: string | null;
		rowsCompared: number;
		mismatched: Array<{ id: string; snapshot: Fit; current: Fit }>;
	} | null;
	/** 最近一份 docs/report-*.md 正文里的 fit 分布语句；与机读产物不一致即告警。 */
	reportProse: {
		file: string;
		claimed: [number, number, number];
	} | null;
}

export interface Alert {
	id: string;
	severity: Severity;
	title: string;
	detail: string;
	evidence: string;
}

export const SEVERITY_RANK: Record<Severity, number> = {
	high: 3,
	warn: 2,
	info: 1,
};

export function worstSeverity(alerts: Alert[]): Severity | null {
	let worst: Severity | null = null;
	for (const alert of alerts) {
		if (!worst || SEVERITY_RANK[alert.severity] > SEVERITY_RANK[worst])
			worst = alert.severity;
	}
	return worst;
}
