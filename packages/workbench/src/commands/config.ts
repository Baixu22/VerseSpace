import type { Command } from "commander";
import { emitJson, type GlobalOptions } from "../output";
import { resolveBlackboard } from "./context";

export async function queueCommand(command: Command): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const bb = await resolveBlackboard();
	const queue = await bb.state.queue.get();
	const detailed = [];
	for (const goalId of queue) {
		const goal = await bb.goals.get(goalId);
		detailed.push({ goalId, title: goal?.title, status: goal?.status });
	}
	if (opts.json) {
		emitJson(detailed);
	} else if (!opts.quiet) {
		if (detailed.length === 0) {
			console.log("（执行队列为空）");
		}
		for (const entry of detailed) {
			console.log(`${entry.goalId} [${entry.status}] ${entry.title}`);
		}
	}
}

export async function configSet(
	key: string,
	value: string,
	command: Command,
): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const bb = await resolveBlackboard();
	const config = await bb.config.load();
	const segments = key.split(".");
	let cursor: Record<string, unknown> = config;
	for (const segment of segments.slice(0, -1)) {
		const next = cursor[segment];
		if (typeof next !== "object" || next === null) {
			throw new Error(`未知配置路径：${key}`);
		}
		cursor = next as Record<string, unknown>;
	}
	const leaf = segments.at(-1) as string;
	const coerced =
		value === "true"
			? true
			: value === "false"
				? false
				: Number.isNaN(Number(value))
					? value
					: Number(value);
	cursor[leaf] = coerced;
	await bb.config.save(config);
	if (opts.json) {
		emitJson({ ok: true, key, value: coerced });
	} else if (!opts.quiet) {
		console.log(`已设置 ${key} = ${JSON.stringify(coerced)}`);
	}
}
