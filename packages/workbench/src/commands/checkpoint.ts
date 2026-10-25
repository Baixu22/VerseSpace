import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { z } from "zod";
import { selectArtifactInputs } from "../artifacts/input-origin";
import { captureArtifactSnapshot } from "../artifacts/snapshot";
import { listArtifactReviews } from "../artifacts/status";
import { CHECKPOINT_ZONES } from "../blackboard/checkpoints";
import { newId } from "../ids";
import { emitJson, type GlobalOptions } from "../output";
import { reviewCheckpoint } from "../runtime/review";
import { captureCodeRollback } from "../runtime/rollback";
import { checkpointVerificationStatus } from "../runtime/verification-status";
import {
	artifactDeclarationSchema,
	artifactInputSelectionSchema,
} from "../types/artifact-evidence";
import type { Checkpoint } from "../types/checkpoint";
import { verificationEvidenceSpecSchema } from "../types/verification-evidence";
import { resolveBlackboard } from "./context";

export async function checkpointCreate(
	options: {
		goal?: string;
		assertion?: string;
		workspot?: string;
		strategy?: string;
		command?: string;
		timeout?: string;
		evidence?: string;
		artifact?: string;
		input?: string[];
		inputRecords?: string;
		targetRef?: string;
		writer?: string;
		thread?: string;
	},
	command: Command,
): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	if (!options.goal || !options.assertion || !options.workspot) {
		throw new Error("checkpoint create 需要 --goal、--assertion、--workspot");
	}
	const strategy = options.strategy;
	const evidence = options.evidence
		? verificationEvidenceSpecSchema.parse(
				JSON.parse(await readFile(options.evidence, "utf8")),
			)
		: undefined;
	if (evidence && (!strategy || strategy === "human-review"))
		throw new Error("--evidence 需要自动验证策略");
	if (options.artifact && !evidence)
		throw new Error("--artifact 需要 --evidence 声明检查范围");
	if (options.inputRecords && !options.artifact)
		throw new Error("--input-records 需要 --artifact");
	const inputRecords = options.inputRecords
		? z
				.array(artifactInputSelectionSchema)
				.min(1)
				.parse(JSON.parse(await readFile(options.inputRecords, "utf8")))
		: undefined;
	const artifact = options.artifact
		? artifactDeclarationSchema.parse({
				path: options.artifact,
				inputs: options.input ?? [],
				inputRecords,
				targetRef: options.targetRef,
			})
		: undefined;
	if (
		strategy &&
		!["test", "type-check", "build", "human-review"].includes(strategy)
	) {
		throw new Error(`未知验证策略：${strategy}`);
	}
	const bb = await resolveBlackboard();
	const goal = await bb.goals.get(options.goal);
	if (!goal) {
		throw new Error(`目标不存在：${options.goal}`);
	}
	// TF-0098：落 checkpoint 的同时采集代码面回退快照（工作区 HEAD + 改动文件）。
	// 没有恢复点的 checkpoint 一律拒绝回退，所以这一步是廉价可逆的地基。
	let rollback: Checkpoint["rollback"];
	const workspot = await bb.state.workspots.get(options.workspot);
	if (workspot) {
		try {
			rollback = { code: await captureCodeRollback(workspot.worktreePath) };
		} catch (error) {
			// 工作区不可读（如派发失败）时不阻塞落 checkpoint，只是没有恢复点
			rollback = undefined;
			console.error(
				`[警告] 未采集代码回退快照（该 checkpoint 无法用于代码回退）：${String(error)}`,
			);
		}
	}
	const checkpoint: Checkpoint = {
		id: newId("cp"),
		goal: options.goal,
		workspot: options.workspot,
		timestamp: new Date().toISOString(),
		lifecycle: "draft",
		assertion: options.assertion,
		verification:
			strategy === undefined
				? undefined
				: {
						strategy: strategy as
							| "test"
							| "type-check"
							| "build"
							| "human-review",
						command: options.command,
						timeout: options.timeout ? Number(options.timeout) : undefined,
						evidence,
					},
		artifacts: [],
		artifact,
		writerId: options.writer,
		threadId: options.thread,
		unblocks: [],
		rollback,
	};
	checkpoint.artifactOrigin = await captureArtifactSnapshot(bb, checkpoint);
	checkpoint.artifactInputOrigin = await selectArtifactInputs(bb, checkpoint);
	await bb.checkpoints.save(checkpoint, "staging");
	await bb.goals.update(options.goal, {
		checkpoints: [...goal.checkpoints, checkpoint.id],
	});
	if (opts.json) {
		emitJson(checkpoint);
	} else if (!opts.quiet) {
		console.log(
			`已落 checkpoint ${checkpoint.id}（staging/draft，目标 ${options.goal}）`,
		);
	}
}

export async function checkpointList(
	options: { staging?: boolean; verified?: boolean; failed?: boolean },
	command: Command,
): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const bb = await resolveBlackboard();
	const zones = options.staging
		? (["staging"] as const)
		: options.verified
			? (["verified"] as const)
			: options.failed
				? (["failed"] as const)
				: CHECKPOINT_ZONES;
	const artifacts = await listArtifactReviews(bb);
	const grouped = new Map<
		string,
		Array<
			Checkpoint & {
				currentVerification: Awaited<
					ReturnType<typeof checkpointVerificationStatus>
				>;
			}
		>
	>();
	for (const zone of zones) {
		grouped.set(
			zone,
			await Promise.all(
				(await bb.checkpoints.scanZone(zone)).map(async (cp) => ({
					...cp,
					currentVerification: await checkpointVerificationStatus(bb, cp),
					currentArtifact: artifacts.find(
						(artifact) => artifact.rootId === (cp.revalidates ?? cp.id),
					),
				})),
			),
		);
	}
	if (opts.json) {
		emitJson(Object.fromEntries(grouped));
	} else if (!opts.quiet) {
		for (const [zone, checkpoints] of grouped) {
			console.log(`[${zone}]`);
			if (checkpoints.length === 0) {
				console.log("  （空）");
			}
			for (const cp of checkpoints) {
				console.log(
					`  ${cp.id}  ${cp.lifecycle.padEnd(16)} ${cp.assertion}；${cp.currentVerification.message}`,
				);
				const artifact = artifacts.find(
					(entry) => entry.rootId === (cp.revalidates ?? cp.id),
				);
				if (artifact)
					console.log(
						`    产物 ${artifact.path}：${artifact.status}；${artifact.reason}；重验入口 checkpoint revalidate ${artifact.checkpointId}`,
					);
			}
		}
	}
}

export async function checkpointReview(
	id: string,
	options: { approve?: boolean; reject?: boolean },
	command: Command,
): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	if (options.approve === options.reject) {
		throw new Error("checkpoint review 需要 --approve 或 --reject 之一");
	}
	const bb = await resolveBlackboard();
	const outcome = await reviewCheckpoint(bb, id, options.approve === true);
	if (opts.json) {
		emitJson(outcome);
	} else if (!opts.quiet) {
		if (!outcome.ok) {
			console.error(`workbench: ${outcome.reason}`);
		} else if (outcome.verdict === "verified") {
			console.log(`checkpoint ${id} 已通过审查，进入 verified 区`);
		} else {
			console.log(`checkpoint ${id} 被驳回，进入 failed 区`);
		}
	}
	if (!outcome.ok) {
		process.exitCode = 1;
	}
}
