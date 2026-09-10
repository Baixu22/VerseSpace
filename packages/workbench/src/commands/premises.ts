import type { Command } from "commander";
import { NoWorkbenchError } from "../errors";
import { emitJson, type GlobalOptions } from "../output";
import { pendingPremiseNotices } from "../runtime/delivery";
import { decideSeal, targetOfHookInput } from "../runtime/seal";
import type { SealMode } from "../runtime/seal-counts";
import { resolveBlackboard } from "./context";

const SEAL_MODES: readonly string[] = ["block", "warn", "off"];

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
				noticeId: notice.noticeId,
				writer: notice.writerId,
				familyFold: notice.familyFold,
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
		const foldedPaths = new Set(notice.familyFold?.paths ?? []);
		if (notice.familyFold) {
			const shown = notice.familyFold.paths.slice(0, 3);
			const extra = foldedPaths.size - shown.length;
			console.log(
				`  同一分叉家族近 30 分钟改动 ${foldedPaths.size} 个文件（已折叠）：${shown.join("、")}${extra ? `；及另 ${extra} 条` : ""}`,
			);
		}
		for (const claim of notice.claims) {
			if (foldedPaths.has(claim.path)) continue;
			const diff = claim.diff ? "（有 diff）" : "（无读时快照，没有 diff）";
			console.log(
				`  ~ ${claim.path} ${claim.observedVersion?.slice(0, 12) ?? "未知"} → ${claim.currentVersion?.slice(0, 12) ?? "未知"} ${diff}`,
			);
		}
	}
}

/**
 * The seal point as a Claude Code PreToolUse hook. The wiring ships with the
 * hooks distribution (TF-0105's installer and plugin bundle), so installing it
 * is the whole setup — no hand-edited settings.json.
 *
 * Exit 0 lets the call through; exit 2 blocks it and feeds stderr back to the
 * model, which is the whole point — the writer needs the evidence, not a
 * refusal. `seal.mode` decides which of the two a match produces, and every
 * decision (including passes) lands in events.jsonl as `seal.decided`.
 */
export async function premisesSealCommand(
	options: { writer?: string; target?: string; mode?: string },
	command: Command,
): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	let bb: Awaited<ReturnType<typeof resolveBlackboard>>;
	try {
		bb = await resolveBlackboard();
	} catch (error) {
		if (error instanceof NoWorkbenchError) {
			// The hook ships enabled by default (TF-0105 distribution), so it runs
			// in repos that have no blackboard at all. No blackboard means no
			// opinion — same rule as no target. Anything else here would put a
			// stderr line in front of every write in every repo.
			return;
		}
		throw error;
	}

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
	const outcome = await decideSeal(bb, {
		target,
		writerId,
		claims,
		mode: SEAL_MODES.includes(options.mode as SealMode)
			? (options.mode as SealMode)
			: undefined,
	});

	if (opts.json && !opts.quiet) {
		emitJson({
			blocked: outcome.decision === "block",
			decision: outcome.decision,
			hit: outcome.hit,
			target: outcome.path,
			mode: outcome.mode,
			effectiveMode: outcome.effectiveMode,
			downgraded: outcome.downgraded,
			matchedDeclarations: outcome.matchedDeclarations,
			reason: outcome.reason,
		});
	}

	if (!outcome.hit) {
		return;
	}
	// warn and off never hide the reason — they only decline to stop the write.
	// stderr is where the host feeds text back to the model, so the evidence
	// reaches the writer in all three modes.
	process.stderr.write(`${outcome.reason}\n`);
	if (outcome.downgraded) {
		process.stderr.write(
			`（连续 ${outcome.priorBlockStreak} 次封印后自动降级为 warn：本次不阻断，请自行判断。）\n`,
		);
	} else if (outcome.decision !== "block") {
		process.stderr.write(
			`（seal.mode = ${outcome.effectiveMode}：本次不阻断，只报告。）\n`,
		);
	}
	if (outcome.decision === "block") {
		process.exit(2);
	}
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
