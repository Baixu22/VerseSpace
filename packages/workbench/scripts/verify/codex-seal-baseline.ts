import { join } from "node:path";
import type { Blackboard } from "../../src/blackboard";
import { claimVersion } from "../../src/blackboard/claim-version";
import { currentPremiseNotices } from "../../src/runtime/premises";
import { normalizeTarget } from "../../src/runtime/seal";

export function probeCase(args: string[]): "own-stale" | "own-fresh" {
	const index = args.indexOf("--case");
	const value = index === -1 ? "own-stale" : args[index + 1];
	if (value !== "own-stale" && value !== "own-fresh")
		throw new Error("--case 只接受 own-stale / own-fresh");
	return value;
}

/** Capture the SAME writer's premise immediately before the write turn. */
export async function sealBaseline(
	bb: Blackboard,
	writerId: string,
	target: string,
	stale: boolean,
) {
	const view = await bb.sessions.readSetView(writerId);
	const reads = [...view.readFragments.values()]
		.flat()
		.filter((r) => normalizeTarget(bb.projectRoot, r.path) === target);
	if (!reads.some((read) => claimVersion(read) != null))
		throw new Error("真实读回合没有可比较的目标文件足迹，无法测量封印因果");
	const claims = (await currentPremiseNotices(bb, writerId))
		.flatMap((n) => n.stale)
		.filter((c) => normalizeTarget(bb.projectRoot, c.path) === target);
	if (stale !== claims.length > 0)
		throw new Error("前提状态不符合案例，不能把无前提放行当作封印结果");
	return { writerId, target: join(bb.projectRoot, target), claims };
}
