/**
 * TF-0137 · fit 账本与砍留决策
 *
 * 把「真实使用有没有用」变成可引用的一等状态。账本不是手写的：scope 来自森林、
 * 值来自本仓库 `.workbench/` 的真实事件，每行都带来源。两条纪律写在
 * scripts/fit-ledger/metrics.ts 的头注里，简言之：
 *
 *   - fit 词表与 task-forest 的 alignment.fit 完全一致（五个值，不另造一套）；
 *   - 无真实使用一律 unknown，测试通过不算使用。
 *
 * 用法：
 *   bun run scripts/fit-ledger.ts                    # 打到 stdout
 *   bun run scripts/fit-ledger.ts --out ../../docs/fit-ledger.md
 *   bun run scripts/fit-ledger.ts --json             # 机读
 *   bun run scripts/fit-ledger.ts --evidence-kind live-model --json
 *   bun run scripts/fit-ledger.ts --blackboard <租户>/.workbench --scope <仓库>
 *
 * --blackboard 是给「黑板与森林分处两地」用的：不写它时黑板由 cwd 决定，而
 * 从仓库里跑租户账本会静默读到仓库自己的黑板（2026-09-10 实测：7 线程 / 0 地标），
 * 看起来有数、其实不是同一个现场。显式传路径让样本源不再依赖你站在哪。
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { openBlackboard } from "../src/blackboard";
import { collectChatStats } from "../src/chat/stats";
import { resolveBlackboard } from "../src/commands/context";
import type { WriterKind } from "../src/types/session";
import {
	benchmarkGate,
	buildRows,
	fitHistogram,
	loadScope,
	moatNumbers,
	sampleWindow,
	t0Started,
} from "./fit-ledger/ledger";
import type { Ctx } from "./fit-ledger/metrics";
import { renderMarkdown } from "./fit-ledger/render";
import { assessVerdicts, parseEvidenceKind } from "./fit-ledger/verdicts";

async function main(): Promise<void> {
	const argv = Bun.argv.slice(2);
	const kindAt = argv.indexOf("--evidence-kind");
	const evidenceKind = parseEvidenceKind(
		kindAt < 0 ? "unknown" : (argv[kindAt + 1] ?? ""),
	);
	const blackboardAt =
		argv.indexOf("--blackboard") >= 0
			? argv[argv.indexOf("--blackboard") + 1]
			: undefined;
	const bb = blackboardAt
		? openBlackboard(resolve(blackboardAt))
		: await resolveBlackboard();
	const [stats, events, writers] = await Promise.all([
		collectChatStats(bb),
		bb.events.all(),
		bb.sessions.list(),
	]);
	const ctx: Ctx = {
		stats,
		events,
		writerKind: new Map<string, WriterKind>(writers.map((w) => [w.id, w.kind])),
	};
	const scopeRoot = (() => {
		const at = argv.indexOf("--scope");
		return at >= 0 ? (argv[at + 1] as string) : bb.projectRoot;
	})();
	// --scope 让行集（森林，权威 scope）与值（黑板）可以来自两处：租户黑板
	// 有样本但没森林，本仓库有森林但 t0 未开始——账本此前只能在一边全 unknown。
	const scope = await loadScope(scopeRoot);
	const rows = buildRows(scope, ctx, evidenceKind);
	const moat = moatNumbers(ctx);
	const gate = benchmarkGate(moat);
	const histogram = fitHistogram(rows);
	const t0 = {
		started: t0Started(ctx),
		threads: stats.threads.total,
		writers: ctx.writerKind.size,
	};
	const window = sampleWindow(ctx);
	const report = {
		generatedAt: new Date().toISOString(),
		blackboard: bb.paths.root,
		evidenceKind,
		observation: stats.observation,
		dataQuality: stats.dataQuality,
		t0,
		sampleWindow: window,
		premisesRecent: stats.premisesRecent,
		restoreToMessage: stats.lifecycle.restoreToMessage,
		landmarkReviews: stats.landmarkReviews,
		histogram,
		moat,
		gate,
		verdicts: assessVerdicts(ctx, evidenceKind),
		rows,
	};

	if (argv.includes("--json")) {
		console.log(JSON.stringify(report, null, 2));
		return;
	}

	const markdown = renderMarkdown(report);
	const outAt = argv.indexOf("--out");
	const outPath = outAt >= 0 ? argv[outAt + 1] : undefined;
	if (outPath) {
		await writeFile(outPath, markdown, "utf8");
		console.log(`wrote ${outPath}`);
		return;
	}
	console.log(markdown);
}

await main();
