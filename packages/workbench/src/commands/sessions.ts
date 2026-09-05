import type { Command } from "commander";
import type { Blackboard } from "../blackboard";
import { hashPathClaim } from "../blackboard/footprint";
import { NoWorkbenchError } from "../errors";
import { emitJson, type GlobalOptions } from "../output";
import { WRITER_KINDS, type WriterKind } from "../types/session";
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

/** Newline-separated paths on stdin, for `git diff --name-only | workbench …`. */
async function readStdinPaths(): Promise<string[]> {
	if (process.stdin.isTTY) {
		return [];
	}
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks)
		.toString("utf8")
		.split(/\r?\n|\0/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

/**
 * Paths the runtime must not record as writer activity.
 *
 * A `git merge` that also updates `.workbench/` would otherwise have the
 * blackboard describing its own event log as a change in the world it
 * describes. The watcher already excludes the blackboard from capture; this
 * keeps the hook path consistent with it.
 */
function isSelfOwned(path: string): boolean {
	const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
	return (
		normalized === ".workbench" ||
		normalized.startsWith(".workbench/") ||
		normalized.includes("/.workbench/")
	);
}

/**
 * Register a non-agent writer's activity from outside the runtime (TF-0150).
 *
 * The blackboard already accepts `kind: "git"` writers and already has
 * `recordActivity`; what was missing was any way to reach them without being a
 * TypeScript caller. Writer-neutrality is a claim about the blackboard, and it
 * stays a slogan until something that is neither an agent nor a person can put
 * a write on the record — so the defaults here are the git case.
 *
 * Paths come from `--generated` / `--used`, or from stdin, which is what the
 * git hooks use: `git diff-tree -r --name-only … | workbench sessions record`.
 */
export async function sessionsRecordCommand(
	options: {
		writer?: string;
		kind?: string;
		label?: string;
		activity?: string;
		generated?: string[];
		used?: string[];
	},
	command: Command,
): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	let bb: Blackboard;
	try {
		bb = await resolveBlackboard();
	} catch (error) {
		if (error instanceof NoWorkbenchError) {
			// This runs from git hooks that ship enabled. A repo with no
			// blackboard has nothing to record into, and a hook that fails on
			// every merge in every other repo would get uninstalled by hand.
			return;
		}
		throw error;
	}

	const kind = (options.kind ?? "git") as WriterKind;
	if (!WRITER_KINDS.includes(kind)) {
		throw new Error(
			`未知写者类型：${options.kind}（可选 ${WRITER_KINDS.join(" / ")}）`,
		);
	}
	const writerId = options.writer ?? "git";
	const explicit = [...(options.generated ?? []), ...(options.used ?? [])];
	const fromStdin = explicit.length === 0 ? await readStdinPaths() : [];
	const generatedPaths = [
		...new Set([...(options.generated ?? []), ...fromStdin]),
	].filter((path) => !isSelfOwned(path));
	const usedPaths = [...new Set(options.used ?? [])].filter(
		(path) => !isSelfOwned(path),
	);

	if (generatedPaths.length === 0 && usedPaths.length === 0) {
		// A merge that changed nothing is not an activity. Recording an empty
		// footprint would inflate the writer's clock with content-free rounds.
		if (opts.json && !opts.quiet) {
			emitJson({ writer: writerId, kind, recorded: 0 });
		}
		return;
	}

	await bb.sessions.register(
		writerId,
		kind,
		options.label ?? (kind === "git" ? "git（hook 捕获）" : writerId),
	);
	const activity = options.activity ?? `${kind}-${Date.now()}`;
	const [generated, used] = await Promise.all([
		Promise.all(
			generatedPaths.map((path) => hashPathClaim(bb.projectRoot, path)),
		),
		Promise.all(usedPaths.map((path) => hashPathClaim(bb.projectRoot, path))),
	]);
	await bb.sessions.recordActivity(writerId, {
		activity,
		agent: writerId,
		used,
		generated,
		facets: { via: "cli", channel: kind },
	});

	if (opts.json) {
		emitJson({
			writer: writerId,
			kind,
			activity,
			generated: generated.map((claim) => claim.path),
			used: used.map((claim) => claim.path),
			recorded: generated.length + used.length,
		});
		return;
	}
	if (opts.quiet) {
		return;
	}
	console.log(
		`已记录写者 ${writerId}[${kind}] 的一次活动 ${activity}：写 ${generated.length} 个，读 ${used.length} 个`,
	);
}
