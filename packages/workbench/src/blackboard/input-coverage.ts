import { z } from "zod";
import type { Blackboard } from ".";
import { claimObservation, claimStrength } from "./claim-version";
import type { FootprintUsed } from "./session-types";

const count = z.number().int().nonnegative();
export const inputCoverageSchema = z
	.strictObject({
		schemaVersion: z.literal(1),
		observability: z.enum(["footprint", "unobservable"]),
		unit: z.literal("received-file-tool-events"),
		candidates: count,
		successful: count,
		failed: count,
		pending: count,
		observedEvents: count,
		paths: z.strictObject({
			toolObserved: count,
			fsSample: count,
			declared: count,
			sizeOnly: count,
			unknown: count,
		}),
		bindings: z.strictObject({
			matched: count,
			different: count,
			unknown: count,
		}),
		reasons: z.record(z.string(), count),
	})
	.refine(
		(value) =>
			value.candidates === value.successful + value.failed + value.pending &&
			value.observedEvents <= value.successful &&
			value.bindings.matched +
				value.bindings.different +
				value.bindings.unknown ===
				value.paths.toolObserved &&
			(value.observability !== "unobservable" || value.candidates === 0),
	);
export type InputCoverage = z.infer<typeof inputCoverageSchema>;

/** Per received tool id, not per actual filesystem operation or inferred model use. */
export function createInputCoverage(
	observability: InputCoverage["observability"] = "footprint",
) {
	const attempts = new Map<
		string,
		{
			outcome: "pending" | "failed" | "successful";
			reads: FootprintUsed[];
			received?: boolean;
		}
	>();
	return {
		begin(id?: string) {
			if (!id || id === "act-unknown") id = `unidentified-${attempts.size}`;
			if (!attempts.has(id))
				attempts.set(id, { outcome: "pending", reads: [] });
		},
		acceptResult(id: string) {
			const attempt = attempts.get(id);
			if (!attempt) return true;
			if (attempt.received) return false;
			attempt.received = true;
			return true;
		},
		settle(id: string, reads: FootprintUsed[] | null) {
			const attempt = attempts.get(id);
			if (attempt?.outcome !== "pending") return;
			attempt.outcome = reads === null ? "failed" : "successful";
			attempt.reads = reads ?? [];
		},
		finish(): InputCoverage {
			const result: InputCoverage = {
				schemaVersion: 1,
				observability,
				unit: "received-file-tool-events",
				candidates: attempts.size,
				successful: 0,
				failed: 0,
				pending: 0,
				observedEvents: 0,
				paths: {
					toolObserved: 0,
					fsSample: 0,
					declared: 0,
					sizeOnly: 0,
					unknown: 0,
				},
				bindings: { matched: 0, different: 0, unknown: 0 },
				reasons: {},
			};
			const reason = (text: string) => {
				result.reasons[text] = (result.reasons[text] ?? 0) + 1;
			};
			for (const attempt of attempts.values()) {
				result[attempt.outcome]++;
				if (attempt.outcome !== "successful") {
					reason(
						attempt.outcome === "failed"
							? "工具失败"
							: "未收到成功结果或缺少工具身份",
					);
					continue;
				}
				if (!attempt.reads.length) {
					reason("没有可归因的文件路径");
					continue;
				}
				let observed = true;
				for (const read of attempt.reads) {
					const evidence = claimObservation(read);
					if (evidence.source === "tool-observed") {
						result.paths.toolObserved++;
						result.bindings[evidence.binding]++;
					} else {
						observed = false;
						if (evidence.source === "fs-sample") result.paths.fsSample++;
						else if (evidence.source === "declared") result.paths.declared++;
						else if (claimStrength(read) === "size-only")
							result.paths.sizeOnly++;
						else result.paths.unknown++;
						reason(evidence.reason);
					}
				}
				if (observed) result.observedEvents++;
			}
			return result;
		},
	};
}
export type InputCoverageTracker = ReturnType<typeof createInputCoverage>;

/** A compact append-only session observation, never a world validity verdict. */
export async function recordInputCoverage(
	bb: Blackboard,
	writer: string,
	coverage: InputCoverage,
	turnId?: string,
) {
	inputCoverageSchema.parse(coverage);
	await bb.events.append({
		timestamp: new Date().toISOString(),
		source: "capture",
		type: "input_coverage",
		payload: { writer, turnId, coverage },
	});
}

export async function inputCoverageView(
	bb: Blackboard,
	writer: string,
	observability?: InputCoverage["observability"],
) {
	const events = await bb.events.query({ type: "input_coverage" });
	const latest = [...events]
		.reverse()
		.find((event) => (event.payload as { writer?: string })?.writer === writer);
	const parsed = inputCoverageSchema.safeParse(
		(latest?.payload as { coverage?: unknown })?.coverage,
	);
	const coverage = parsed.success ? parsed.data : undefined;
	const status =
		observability === "unobservable" ||
		coverage?.observability === "unobservable"
			? "unobservable"
			: !coverage
				? "unknown"
				: coverage.candidates === 0
					? "zero"
					: "available";
	return {
		status,
		scope: "latest-recorded-turn",
		unit: "received-file-tool-events",
		coverage: coverage ?? null,
		observedRatio:
			status === "available" && coverage
				? coverage.observedEvents / coverage.candidates
				: null,
		refs: latest?.id ? [latest.id] : [],
		text:
			status === "unobservable"
				? "输入覆盖不可计算：HTTP 通道 unobservable。"
				: status === "unknown"
					? "输入覆盖未知：旧日志缺少本轮候选工具事件计数。"
					: status === "zero"
						? "输入覆盖不可计算：本轮收到 0 个候选文件工具事件。"
						: `输入覆盖（最近记录轮次，收到的候选文件工具事件）：${coverage!.observedEvents}/${coverage!.candidates} 个有可归因内容；成功 ${coverage!.successful}、失败 ${coverage!.failed}、未完成 ${coverage!.pending}；路径凭据（条）：工具 ${coverage!.paths.toolObserved}、采样 ${coverage!.paths.fsSample}、声明 ${coverage!.paths.declared}、仅大小 ${coverage!.paths.sizeOnly}、未知 ${coverage!.paths.unknown}。${Object.entries(
								coverage!.reasons,
							)
								.map(([reason, count]) => `${reason} ${count}`)
								.join("；")}`,
	};
}
