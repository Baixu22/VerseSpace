import { isAbsolute, relative } from "node:path";
import type { StalePremiseClaim } from "./premises";

/**
 * The seal point (R2, TF-0078): the ONE place where the runtime is allowed to
 * interrupt a writer.
 *
 * The rule everywhere else is advisory — observe and notify, never command.
 * But writing into a region you know to have moved under the writer's feet is
 * not an interruption, it is a seal: the write would be built on a premise
 * that is already false, and undoing it later costs more than being stopped.
 *
 * So this is a pure predicate plus a message. It blocks with exit code 2 and
 * puts the evidence on stderr, which Claude Code feeds back to the model —
 * the writer gets something it can actually patch against, not a bare refusal.
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
