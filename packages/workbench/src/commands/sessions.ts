import type { Command } from "commander";
import type { Blackboard } from "../blackboard";
import { emitJson, type GlobalOptions } from "../output";
import { resolveBlackboard } from "./context";

/**
 * R1's answer surface: after a session ends, the runtime can say what the
 * writer read (and which version it observed) and what it wrote.
 */

async function summarize(bb: Blackboard, id: string) {
	const writer = await bb.sessions.get(id);
	if (!writer) {
		return null;
	}
	const { reads, writes } = await bb.sessions.readSetView(id);
	return {
		writer,
		reads: [...reads.values()].sort((a, b) => a.path.localeCompare(b.path)),
		writes: writes.sort((a, b) => a.seq - b.seq),
	};
}

export async function sessionsListCommand(command: Command): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const bb = await resolveBlackboard();
	const writers = await bb.sessions.list();
	if (opts.json) {
		emitJson({ sessions: writers });
		return;
	}
	if (opts.quiet) {
		return;
	}
	if (writers.length === 0) {
		console.log("（还没有注册的写者）");
	}
	for (const writer of writers) {
		console.log(
			`${writer.id} [${writer.kind}/${writer.status}] ${writer.label}（最近活跃 ${writer.lastActiveAt}）`,
		);
	}
}

export async function sessionsShowCommand(
	options: { writer: string },
	command: Command,
): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const bb = await resolveBlackboard();
	const summary = await summarize(bb, options.writer);
	if (!summary) {
		throw new Error(`写者未注册：${options.writer}`);
	}
	if (opts.json) {
		emitJson(summary);
		return;
	}
	if (opts.quiet) {
		return;
	}
	const { writer, reads, writes } = summary;
	console.log(`${writer.id} [${writer.kind}/${writer.status}] ${writer.label}`);
	console.log(`读集（${reads.length} 个文件，每路径为最后观察到的版本）：`);
	for (const read of reads) {
		const version = read.version
			? read.version.slice(0, 12)
			: read.size !== undefined
				? `${read.size}B（未哈希）`
				: "未知（文件缺失）";
		console.log(`  ~ ${read.path} @ ${version}（seq ${read.seq}）`);
	}
	console.log(`写集（${writes.length} 次）：`);
	for (const write of writes) {
		const version = write.version
			? write.version.slice(0, 12)
			: write.size !== undefined
				? `${write.size}B（未哈希）`
				: "未知";
		console.log(
			`  + ${write.path} → ${version}（seq ${write.seq}，${write.ts}）`,
		);
	}
}
