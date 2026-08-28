import type { Command } from "commander";
import { CHECKPOINT_ZONES } from "../blackboard/checkpoints";
import { newId } from "../ids";
import { emitJson, type GlobalOptions } from "../output";
import { reviewCheckpoint } from "../runtime/review";
import type { Checkpoint } from "../types/checkpoint";
import { resolveBlackboard } from "./context";

export async function checkpointCreate(
	options: {
		goal?: string;
		assertion?: string;
		workspot?: string;
		strategy?: string;
		command?: string;
		timeout?: string;
	},
	command: Command,
): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	if (!options.goal || !options.assertion || !options.workspot) {
		throw new Error("checkpoint create 需要 --goal、--assertion、--workspot");
	}
	const strategy = options.strategy;
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
					},
		artifacts: [],
		unblocks: [],
	};
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
	const grouped = new Map<string, Checkpoint[]>();
	for (const zone of zones) {
		grouped.set(zone, await bb.checkpoints.scanZone(zone));
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
				console.log(`  ${cp.id}  ${cp.lifecycle.padEnd(16)} ${cp.assertion}`);
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
