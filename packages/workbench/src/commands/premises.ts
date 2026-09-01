import type { Command } from "commander";
import { emitJson, type GlobalOptions } from "../output";
import { pendingPremiseNotices } from "../runtime/delivery";
import { judgeSeal, targetOfHookInput } from "../runtime/seal";
import { resolveBlackboard } from "./context";

/**
 * R2's inspection surface. Detection writes `premise_stale` events; this
 * shows which of them have not reached their writer yet. Delivery itself is
 * the session-owning host's job (the UI server), so the CLI stays read-only.
 */

export async function premisesPendingCommand(command: Command): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const bb = await resolveBlackboard();
	const pending = await pendingPremiseNotices(bb);
	if (opts.json) {
		emitJson({
			pending: pending.map((notice) => ({
				writer: notice.writerId,
				stale: notice.claims.map((claim) => ({
					path: claim.path,
					observedVersion: claim.observedVersion,
					currentVersion: claim.currentVersion,
					hasDiff: Boolean(claim.diff),
				})),
			})),
		});
		return;
	}
	if (opts.quiet) {
		return;
	}
	if (pending.length === 0) {
		console.log("（没有待投递的前提失效通知）");
		return;
	}
	for (const notice of pending) {
		console.log(`${notice.writerId}：${notice.claims.length} 个文件待投递`);
		for (const claim of notice.claims) {
			const diff = claim.diff ? "（有 diff）" : "（无读时快照，没有 diff）";
			console.log(
				`  ~ ${claim.path} ${claim.observedVersion?.slice(0, 12) ?? "未知"} → ${claim.currentVersion?.slice(0, 12) ?? "未知"} ${diff}`,
			);
		}
	}
}

/**
 * The seal point as a Claude Code PreToolUse hook. Wire it up with:
 *
 * ```json
 * { "hooks": { "PreToolUse": [{ "matcher": "Write|Edit|MultiEdit|NotebookEdit",
 *     "hooks": [{ "type": "command", "command": "workbench premises seal" }] }] } }
 * ```
 *
 * Exit 0 lets the call through; exit 2 blocks it and feeds stderr back to the
 * model, which is the whole point — the writer needs the evidence, not a
 * refusal.
 */
export async function premisesSealCommand(
	options: { writer?: string; target?: string },
	command: Command,
): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const bb = await resolveBlackboard();

	let target = options.target;
	let writerId = options.writer;
	if (!target) {
		const raw = await readStdin();
		if (raw.trim()) {
			try {
				const payload = JSON.parse(raw) as Record<string, unknown>;
				target = targetOfHookInput(payload) ?? undefined;
				writerId =
					writerId ??
					(typeof payload.session_id === "string"
						? payload.session_id
						: undefined);
			} catch {
				// not a hook payload: fall through to "nothing to judge"
			}
		}
	}

	if (!target) {
		// No target means no opinion. A hook that blocks on what it cannot
		// see would be worse than no hook at all.
		return;
	}

	const pending = await pendingPremiseNotices(bb);
	const claims = (
		writerId
			? pending.filter((notice) => notice.writerId === writerId)
			: pending
	).flatMap((notice) => notice.claims);
	const verdict = judgeSeal(bb.projectRoot, target, claims);

	if (!verdict.blocked) {
		if (opts.json && !opts.quiet) {
			emitJson({ blocked: false, target });
		}
		return;
	}

	if (opts.json && !opts.quiet) {
		emitJson({ blocked: true, target, reason: verdict.reason });
	}
	process.stderr.write(`${verdict.reason}\n`);
	process.exit(2);
}

async function readStdin(): Promise<string> {
	if (process.stdin.isTTY) {
		return "";
	}
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf8");
}
