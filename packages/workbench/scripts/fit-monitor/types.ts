/**
 * TF-0135 / TF-0136 / TF-0137 · 数据监控的类型。
 *
 * 监控与账本的分工：账本回答「现在长什么样」，监控回答「和上一次比，哪一项
 * 变了、变的方向是不是坏」。所以样本是可比的快照（同一黑板的同一批读数），
 * 告警是两次快照之间的差分判断，两者都不写黑板——监控是观察者，不是写者。
 */

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
		total: number;
		reviewed: number;
		endorsed: number;
		rejected: number;
		endorsedShare: number | null;
		reviewedCoverage: number | null;
		pending: number;
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
