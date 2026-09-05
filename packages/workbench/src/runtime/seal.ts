import { isAbsolute, relative } from "node:path";
import type { Blackboard } from "../blackboard";
import type { StalePremiseClaim } from "./premises";
import {
	consecutiveHitStreak,
	SEAL_EVENT,
	type SealDecision,
	type SealDecisionRecord,
	type SealMode,
} from "./seal-counts";

/**
 * The seal point (R2, TF-0078): the ONE place where the runtime is allowed to
 * interrupt a writer.
 *
 * The rule everywhere else is advisory — observe and notify, never command.
 * But writing into a region you know to have moved under the writer's feet is
 * not an interruption, it is a seal: the write would be built on a premise
 * that is already false, and undoing it later costs more than being stopped.
 *
 * So `judgeSeal` is a pure predicate plus a message. It blocks with exit code 2
 * and puts the evidence on stderr, which Claude Code feeds back to the model —
 * the writer gets something it can actually patch against, not a bare refusal.
 *
 * `decideSeal` wraps that predicate in the parts that need the world (TF-0134):
 * the configured mode, the consecutive-block downgrade, and the record of what
 * was decided. Keeping the predicate pure is deliberate — the decision policy
 * changes far more often than the question "did this write land on a claim".
 */

export type SealVerdict =
	| { blocked: false }
	| { blocked: true; reason: string; evidence: StalePremiseClaim[] };

/** Tool inputs that carry a file target, in the shape the CLI sends them. */
export function targetOfHookInput(
	payload: Record<string, unknown>,
): string | null {
	const input = payload.tool_input;
	if (typeof input !== "object" || input === null) {
		return null;
	}
	const args = input as Record<string, unknown>;
	if (typeof args.file_path === "string" && args.file_path) {
		return args.file_path;
	}
	if (typeof args.notebook_path === "string" && args.notebook_path) {
		return args.notebook_path;
	}
	return null;
}

/** Project-relative, forward-slashed — the shape footprint claims use. */
export function normalizeTarget(projectRoot: string, target: string): string {
	const slash = target.replace(/\\/g, "/");
	if (isAbsolute(slash)) {
		const root = projectRoot.replace(/\\/g, "/");
		const rel = relative(root, slash).replace(/\\/g, "/");
		return rel.startsWith("..") ? slash : rel;
	}
	return slash.replace(/^\.\//, "");
}

function overlaps(target: string, claim: string): boolean {
	return (
		target === claim ||
		claim.startsWith(`${target}/`) ||
		target.startsWith(`${claim}/`)
	);
}

export function judgeSeal(
	projectRoot: string,
	target: string,
	claims: StalePremiseClaim[],
): SealVerdict {
	const normalized = normalizeTarget(projectRoot, target);
	const hit = claims.filter((claim) => overlaps(normalized, claim.path));
	if (hit.length === 0) {
		return { blocked: false };
	}
	const listed = hit
		.map(
			(claim) =>
				`- ${claim.path}（你读到的是 ${claim.observedVersion?.slice(0, 12) ?? "未知"}，` +
				`现在是 ${claim.currentVersion?.slice(0, 12) ?? "未知"}）`,
		)
		.join("\n");
	return {
		blocked: true,
		reason:
			`封印点：${normalized} 在你读过后已被其他写者修改。` +
			"这不是打断——基于已失效的前提写下去，事后返工的代价远高于现在停一下。\n" +
			`失效范围：\n${listed}\n` +
			"请先重新读取这些文件确认现状，再决定这次写入是否仍然成立；" +
			"如果前提只是部分失效，只修补依赖失效值的那几步。",
		evidence: hit,
	};
}

export interface SealOutcome extends SealDecisionRecord {
	/** The evidence text. Present whenever the predicate matched, in EVERY
	 * mode — `warn` and `off` change what happens to the write, never whether
	 * the writer is told why. */
	reason?: string;
	evidence: StalePremiseClaim[];
	/** Consecutive unresolved hits by this writer, counted before this one. */
	priorBlockStreak: number;
}

export interface DecideSealOptions {
	target: string;
	/** Writer id when the host knows it; the streak is counted per writer. */
	writerId?: string;
	claims: StalePremiseClaim[];
	/** Override the configured mode (tests and `--mode`); config wins by default. */
	mode?: SealMode;
}

/**
 * Judge one write, apply the configured posture, and record the decision.
 *
 * The record is written for passes too. A log that only holds refusals cannot
 * answer "was that seal correct?", and that question is the whole reason the
 * seal is allowed to exist at all.
 */
export async function decideSeal(
	bb: Blackboard,
	options: DecideSealOptions,
): Promise<SealOutcome> {
	const config = await bb.config.load();
	const mode = options.mode ?? config.seal.mode;
	const limit = config.seal.consecutiveBlockLimit;
	const writer = options.writerId ?? null;
	const verdict = judgeSeal(bb.projectRoot, options.target, options.claims);
	const path = normalizeTarget(bb.projectRoot, options.target);

	const priorBlockStreak = verdict.blocked
		? consecutiveHitStreak(await bb.events.query({ type: SEAL_EVENT }), writer)
		: 0;
	// `consecutiveBlockLimit` is how many hits in a row a writer may absorb
	// before the seal stops interrupting it. The streak counts hits rather than
	// blocks so the downgrade, once it fires, stays in force.
	const downgraded =
		verdict.blocked && mode === "block" && priorBlockStreak >= limit;
	const effectiveMode: SealMode = downgraded ? "warn" : mode;

	let decision: SealDecision = "pass";
	if (verdict.blocked) {
		decision = effectiveMode === "block" ? "block" : "warn";
		if (effectiveMode === "off") {
			// `off` stops the interruption, not the observation: the write goes
			// through as a pass, but `hit` and the reason stay on the record.
			decision = "pass";
		}
	}

	const record: SealDecisionRecord = {
		writer,
		path,
		decision,
		hit: verdict.blocked,
		matchedDeclarations: verdict.blocked
			? verdict.evidence.map((claim) => claim.path)
			: [],
		mode,
		effectiveMode,
		downgraded,
	};
	await bb.events.append({
		timestamp: new Date().toISOString(),
		source: "runtime",
		type: SEAL_EVENT,
		payload: { ...record },
	});

	return {
		...record,
		reason: verdict.blocked ? verdict.reason : undefined,
		evidence: verdict.blocked ? verdict.evidence : [],
		priorBlockStreak,
	};
}
