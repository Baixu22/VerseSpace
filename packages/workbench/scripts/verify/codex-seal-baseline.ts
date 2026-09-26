import { join } from "node:path";
import type { Blackboard } from "../../src/blackboard";
import { pendingPremiseNotices } from "../../src/runtime/delivery";
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
	const reads = [...view.reads.values()].filter(
		(r) => normalizeTarget(bb.projectRoot, r.path) === target,
	);
	if (reads.length === 0)
		throw new Error("真实读回合没有目标文件足迹，无法测量封印因果");
	const claims = (await pendingPremiseNotices(bb))
		.filter((n) => n.writerId === writerId)
		.flatMap((n) => n.claims)
		.filter((c) => normalizeTarget(bb.projectRoot, c.path) === target);
	if (stale !== claims.length > 0)
		throw new Error("前提状态不符合案例，不能把无前提放行当作封印结果");
	return { writerId, target: join(bb.projectRoot, target), claims };
}
