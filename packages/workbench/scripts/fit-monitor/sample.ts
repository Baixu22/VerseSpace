/**
 * TF-0135 / TF-0136 / TF-0137 · 监控样本的采集。
 *
 * 只读：打开黑板读事件、读租户的跑次历史与模型调用记录，不写任何黑板数据。
 * 样本必须可与上一次逐字段比较，所以这里不做「顺手修一下」的动作——越权写
 * 样本源会让后面的差分判断失去可信度。
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { openBlackboard } from "../../src/blackboard";
import { collectChatStats } from "../../src/chat/stats";
import type { WorkbenchEvent } from "../../src/types/event";
import type { WriterKind } from "../../src/types/session";
import {
	benchmarkGate,
	buildRows,
	fitHistogram,
	loadScope,
	moatNumbers,
	sampleWindow,
	t0Started,
} from "../fit-ledger/ledger";
import type { Ctx, EvidenceKind, Fit } from "../fit-ledger/metrics";
import { PROBES } from "../fit-ledger/metrics";
import { assessVerdicts } from "../fit-ledger/verdicts";
import type { MonitorSample } from "./types";

async function readJsonl<T>(path: string): Promise<T[]> {
	const text = await readFile(path, "utf8").catch(() => "");
	return text
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as T);
}

interface RoundRecord {
	at: string;
	round: number;
	ok: boolean;
}

interface AttemptRecord {
	at: string;
	outcome: string;
	attempt: number;
	status: number | null;
}

export async function collectRounds(workspace: string): Promise<{
	total: number;
	ok: number;
	failed: number;
	lastAt: string | null;
}> {
	const rows = await readJsonl<RoundRecord>(
		join(workspace, "runs/history.jsonl"),
	);
	const ok = rows.filter((row) => row.ok).length;
	return {
		total: rows.length,
		ok,
		failed: rows.length - ok,
		lastAt: rows.at(-1)?.at ?? null,
	};
}

export async function collectModelTrace(workspace: string): Promise<{
	calls: number;
	attempts: number;
	retryRate: number;
	outcomes: Record<string, number>;
	lastOutcomeAt: string | null;
}> {
	const dir = join(workspace, ".workbench/live-agent");
	const [calls, attempts] = await Promise.all([
		readJsonl<{ at: string }>(join(dir, "calls.jsonl")),
		readJsonl<AttemptRecord>(join(dir, "attempts.jsonl")),
	]);
	const outcomes: Record<string, number> = {};
	for (const attempt of attempts)
		outcomes[attempt.outcome] = (outcomes[attempt.outcome] ?? 0) + 1;
	return {
		calls: calls.length,
		attempts: attempts.length,
		retryRate:
			calls.length > 0 ? (attempts.length - calls.length) / calls.length : 0,
		outcomes,
		lastOutcomeAt: attempts.at(-1)?.at ?? null,
	};
}

/**
 * 最近一次落库的账本快照（docs/fit-ledger*.md）。报告里的分布数字必须是
 * 机读产物的复述，不能是转述——所以监控把快照表格重新读一遍并与当前现场
 * 逐行比对，让「文档和账本对不上」变成一个会自己出现的告警。
 */
export async function readLatestSnapshot(
	dir: string,
	workspace: string,
): Promise<{ file: string; fits: Map<string, Fit> } | null> {
	const entries = await readdir(dir).catch(() => [] as string[]);
	const candidates: Array<{ path: string; at: number }> = [];
	for (const name of entries) {
		if (!/^fit-ledger.*\.md$/.test(name)) continue;
		const path = join(dir, name);
		const info = await stat(path).catch(() => null);
		if (info) candidates.push({ path, at: info.mtimeMs });
	}
	const newest = candidates.sort((a, b) => b.at - a.at)[0];
	if (!newest) return null;
	const text = await readFile(newest.path, "utf8").catch(() => "");
	// 账本落库在仓库的 docs/ 下，而监控可以指向任意现场：文档必须自己说明是哪个
	// 现场，才拿它跟当前黑板比。否则「换一个现场跑监控」会立刻报出一堆假漂移
	// （2026-09-11：拿节点验证现场的读数去比租户的报告，一次报了两条）。
	if (!aboutSite(text, workspace)) return null;
	const fits = new Map<string, Fit>();
	for (const line of text.split("\n")) {
		if (!line.startsWith("| TF-")) continue;
		const cells = line.split("|").map((cell) => cell.trim());
		const id = cells[1]?.match(/^(TF-\d+)/)?.[1];
		const fit = cells[4]?.replace(/`/g, "");
		if (id && fit) fits.set(id, fit as Fit);
	}
	return fits.size > 0 ? { file: newest.path, fits } : null;
}

/** 文档是不是在讲这个现场：正文里出现该现场目录名才算。 */
function aboutSite(text: string, workspace: string): boolean {
	const name = basename(workspace.replace(/[\\/]+$/, ""));
	return name.length > 0 && text.includes(name);
}

export async function buildSample(options: {
	workspace: string;
	evidenceKind: EvidenceKind;
	scope: string;
	snapshotDir: string;
	now?: Date;
}): Promise<MonitorSample> {
	const { workspace, evidenceKind, scope, snapshotDir } = options;
	const blackboardRoot = join(workspace, ".workbench");
	const bb = openBlackboard(blackboardRoot);
	const [stats, events, writers, rounds, model] = await Promise.all([
		collectChatStats(bb),
		bb.events.all(),
		bb.sessions.list(),
		collectRounds(workspace),
		collectModelTrace(workspace),
	]);
	const ctx: Ctx = {
		stats,
		events,
		writerKind: new Map<string, WriterKind>(
			writers.map((writer) => [writer.id, writer.kind]),
		),
	};
	const rows = buildRows(await loadScope(scope), ctx, evidenceKind);
	const histogram = fitHistogram(rows);
	const counted = rows.filter((row) => row.kind !== "milestone");
	const unknownRows = counted.filter((row) => row.fit === "unknown");
	const unknown = {
		total: unknownRows.length,
		record: unknownRows.filter((row) => row.kind === "record").length,
		unbuilt: unknownRows.filter((row) => row.kind === "unbuilt").length,
		noSample: unknownRows.filter(
			(row) =>
				row.kind === "component" &&
				PROBES[row.id]?.requires !== "natural" &&
				row.samples === 0,
		).length,
		natural: unknownRows.filter((row) => PROBES[row.id]?.requires === "natural")
			.length,
		ids: unknownRows.map((row) => row.id),
	};
	const landmark = stats.landmarkReviews.current;
	const snapshot = await readLatestSnapshot(snapshotDir, workspace);
	const mismatched: Array<{ id: string; snapshot: Fit; current: Fit }> = [];
	if (snapshot) {
		for (const row of counted) {
			const previous = snapshot.fits.get(row.id);
			if (previous && previous !== row.fit)
				mismatched.push({ id: row.id, snapshot: previous, current: row.fit });
		}
	}
	const proseDrift = await readReportProseDrift(
		snapshotDir,
		histogram,
		workspace,
	);
	const moat = moatNumbers(ctx);
	return {
		at: (options.now ?? new Date()).toISOString(),
		kind: "fit-monitor-sample",
		evidenceKind,
		workspace,
		blackboard: bb.paths.root,
		threads: stats.threads.total,
		writers: ctx.writerKind.size,
		events: events.length,
		days: stats.observation.days,
		t0Started: t0Started(ctx),
		sampleWindow: sampleWindow(ctx),
		moat,
		gate: benchmarkGate(moat),
		verdicts: assessVerdicts(ctx, evidenceKind).map((verdict) => ({
			id: verdict.id,
			title: verdict.title,
			status: verdict.status,
		})),
		histogram,
		unknown,
		natural: {
			total: landmark.total,
			reviewed: landmark.reviewed,
			endorsed: landmark.endorsed,
			rejected: landmark.rejected,
			endorsedShare: landmark.endorsedShare,
			reviewedCoverage: landmark.reviewedCoverage,
			pending: Math.max(0, landmark.total - landmark.reviewed),
		},
		restoreToMessage: {
			samples: stats.lifecycle.restoreToMessage.withCard.samples,
			medianChangeRatio: stats.lifecycle.restoreToMessage.medianChangeRatio,
			exceeds20Percent:
				stats.lifecycle.restoreToMessage.exceeds20Percent ?? null,
		},
		dataQuality: {
			insufficientHistory: stats.dataQuality.insufficientHistory,
			reasons: stats.dataQuality.reasons,
		},
		rounds,
		model,
		snapshot: snapshot
			? {
					file: snapshot.file,
					rowsCompared: counted.length,
					mismatched,
				}
			: null,
		reportProse: proseDrift,
	};
}

export type { WorkbenchEvent };

/**
 * 报告正文里的 fit 分布语句（`aligned 3 · partial 15 · unknown 9` 这种）必须与
 * 机读产物一致。上一轮就是这样出的错：验收报告的正文写着 partial 16 / unknown 6，
 * 而同一份快照的表格是 15 / 9——表格是生成的，正文是转述的，转述没人核对。
 * 这里把转述也纳入比对，让「报告与账本对不上」变成机器能发现的事。
 */
export async function readReportProseDrift(
	dir: string,
	histogram: Record<Fit, number>,
	workspace: string,
): Promise<{ file: string; claimed: [number, number, number] } | null> {
	const entries = await readdir(dir).catch(() => [] as string[]);
	const candidates: Array<{ path: string; at: number }> = [];
	for (const name of entries) {
		if (!/^report-.*\.md$/.test(name)) continue;
		const path = join(dir, name);
		const info = await stat(path).catch(() => null);
		if (info) candidates.push({ path, at: info.mtimeMs });
	}
	const newest = candidates.sort((a, b) => b.at - a.at)[0];
	if (!newest) return null;
	const text = await readFile(newest.path, "utf8").catch(() => "");
	if (!aboutSite(text, workspace)) return null;
	// 一行里同时出现三个标签就算一条声明，三个数字各自取（不要求相邻）：正文常见
	// 的写法是 `aligned 3 · partial 15 · weak 0 · misaligned 0 · unknown 9`，中间
	// 夹着 weak / misaligned。要求 `partial` 紧邻 `unknown` 会漏掉这条正确的声明，
	// 只剩一句解释历史的错数字，于是把已经改好的报告报成漂移。
	const claims: Array<[number, number, number]> = [];
	for (const line of text.split("\n")) {
		if (
			!/aligned\s*\d+/.test(line) ||
			!/partial\s*\d+/.test(line) ||
			!/unknown\s*\d+/.test(line)
		)
			continue;
		claims.push([
			Number(line.match(/aligned\s*(\d+)/)?.[1]),
			Number(line.match(/partial\s*(\d+)/)?.[1]),
			Number(line.match(/unknown\s*(\d+)/)?.[1]),
		]);
	}
	if (claims.length === 0) return null;
	const actual: [number, number, number] = [
		histogram.aligned,
		histogram.partial,
		histogram.unknown,
	];
	// 只要正文里有一条与账本一致，就说明这份报告已经跟着账本改过；剩下的错数字
	// 是它在解释历史，不算漂移。一条都不一致才报，并给出第一条错的那串。
	const matched = claims.some((claim) => claim.join() === actual.join());
	return matched ? null : { file: newest.path, claimed: claims[0]! };
}
