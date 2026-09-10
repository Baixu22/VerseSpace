import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { cliJson, type E2EWorkspace, execPath } from "./driver";
import type { E2EReport, StepRunner } from "./scenario";

interface RestoreTiming {
	withCard: { samples: number; medianMs: number | null };
	withoutCard: { samples: number; medianMs: number | null };
	medianChangeRatio: number | null;
}

export async function collectRunReport(
	ws: E2EWorkspace,
	step: StepRunner,
	report: E2EReport,
): Promise<void> {
	const statsSummary = await step("S10 stats --json 护城河数字", async () => {
		const stats = await cliJson<{
			threads?: { total?: number };
			lifecycle?: { restores?: number; restoreToMessage?: RestoreTiming };
			seal?: {
				decisions?: number;
				blocked?: number;
				reviews?: { correct?: number };
			};
			noticeOutcomes?: { rows?: number };
			premises?: { overlaps?: number; notified?: number };
		}>(ws, ["stats"]);
		const summary = {
			threads: stats.threads?.total,
			restores: stats.lifecycle?.restores,
			sealDecisions: stats.seal?.decisions,
			sealBlocked: stats.seal?.blocked,
			// 护城河 C 的「正确」腿：S7 每轮都 review-seal --correct，
			// 这里断言校准闭环在租户样本里持续在场。
			sealReviewsCorrect: stats.seal?.reviews?.correct,
			noticeOutcomeRows: stats.noticeOutcomes?.rows,
			overlaps: stats.premises?.overlaps,
			notified: stats.premises?.notified,
		};
		for (const [key, value] of Object.entries(summary)) {
			if (!value || (typeof value === "number" && value < 1)) {
				throw new Error(`stats.${key} 为空（${JSON.stringify(summary)}）`);
			}
		}
		const timing = stats.lifecycle?.restoreToMessage;
		if (
			!timing ||
			timing.withCard.samples < 1 ||
			timing.withoutCard.samples < 1 ||
			timing.withCard.medianMs === null ||
			timing.withoutCard.medianMs === null
		)
			throw new Error("恢复耗时缺少有卡/无卡工程样本");
		// Durations are observed, not tuned to pass the product's 20% gate.
		return { ...summary, restoreToMessage: timing };
	});

	await step("S11 fit 账本对租户黑板输出 t0 与样本窗口", async () => {
		const evidenceKind =
			ws.agentScript === resolve(import.meta.dir, "live-agent.ts")
				? "live-model"
				: "scripted";
		const parsed = await new Promise<{
			evidenceKind: string;
			verdicts?: Array<{ id: string; status: string }>;
			t0?: { started: boolean; threads: number; writers: number };
			sampleWindow?: Record<string, unknown>;
			restoreToMessage?: RestoreTiming;
			moat?: Array<{ key: string; present: boolean }>;
		}>((done, fail) => {
			const proc = spawn(
				execPath,
				[
					resolve(import.meta.dir, "..", "fit-ledger.ts"),
					"--json",
					"--evidence-kind",
					evidenceKind,
				],
				{ cwd: ws.projectDir, env: { ...process.env } },
			);
			let out = "";
			proc.stdout.on("data", (chunk) => (out += String(chunk)));
			proc.stderr.on("data", (chunk) => (out += String(chunk)));
			proc.on("exit", (code) =>
				code === 0
					? done(JSON.parse(out.slice(out.indexOf("{"))))
					: fail(new Error(`fit-ledger 退出 ${code}：${out.slice(0, 400)}`)),
			);
			proc.on("error", fail);
		});
		if (!parsed.t0?.started) throw new Error("t0 未被判据点亮");
		if (
			parsed.evidenceKind !== evidenceKind ||
			parsed.verdicts?.length !== 4 ||
			parsed.verdicts.find((row) => row.id === "l3")?.status !==
				"insufficient-evidence"
		)
			throw new Error("工程场景未正确记录来源和四项判决，或误报 L3 门槛通过");
		if (!parsed.moat?.some((row) => row.key === "B" && row.present))
			throw new Error("人的已记录读集没有在 git 删除后失效");
		if (
			JSON.stringify(parsed.restoreToMessage) !==
			JSON.stringify(statsSummary.restoreToMessage)
		) {
			throw new Error("fit 账本与 stats 的恢复耗时读数不一致");
		}
		report.ledgerT0 = parsed.t0 ?? null;
		report.sampleWindow = parsed.sampleWindow ?? null;
		return parsed;
	});

	report.stats = statsSummary as unknown as Record<string, unknown>;
}
