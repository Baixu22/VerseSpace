import type { Blackboard } from "../blackboard";
import { acquireRunLock } from "../fs/lockfile";
import { applyCheckpoint } from "../runtime/checkpoint-effects";
import type { RuntimeNotification } from "../runtime/types";

/** Explicit acceptance after a recheck; consumes the root's effects once, not the recheck. */
export async function consumeArtifact(
	bb: Blackboard,
	id: string,
	evidenceId: string,
) {
	const lock = await acquireRunLock(bb.paths.root);
	if (!lock.acquired) throw new Error("Runtime 忙，不能并发消费产物");
	try {
		const root = (await bb.checkpoints.scanZone("verified")).find(
			(cp) => cp.id === id,
		);
		if (!root?.artifact || root.revalidates)
			throw new Error("需要 verified 区的原声明产物 checkpoint");
		const notifications: RuntimeNotification[] = [];
		const result = await applyCheckpoint(bb, root, notifications, {
			evidenceId,
		});
		return { ...result, rootId: root.id, evidenceId, notifications };
	} finally {
		await lock.release();
	}
}
