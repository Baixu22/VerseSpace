import type { Blackboard } from "../blackboard";
import { acquireRunLock } from "../fs/lockfile";
import { newId } from "../ids";
import { verifyCheckpoint } from "../runtime/verify-checkpoint";
import { checkpointSchema } from "../types/checkpoint";
import { reconcileArtifacts } from "./status";

/** A new evidence-only checkpoint: the original record and effects stay intact. */
export async function revalidateArtifact(
	bb: Blackboard,
	id: string,
	options: { workspot?: string; targetRef?: string } = {},
) {
	const lock = await acquireRunLock(bb.paths.root);
	if (!lock.acquired) throw new Error("Runtime 忙，不能并发重验");
	try {
		const all = Object.values(await bb.checkpoints.scanAll()).flat();
		const original = all.find((cp) => cp.id === id);
		if (!original?.artifact)
			throw new Error(`checkpoint ${id} 没有声明产物依赖`);
		if (
			!original.verification?.evidence ||
			original.verification.strategy === "human-review"
		)
			throw new Error("产物重验需要声明范围的自动检查");
		const rootId = original.revalidates ?? original.id;
		const latestTime = Math.max(
			...all
				.filter((cp) => cp.id === rootId || cp.revalidates === rootId)
				.map((cp) => Date.parse(cp.timestamp)),
		);
		const cp = checkpointSchema.parse({
			id: newId("cp"),
			goal: original.goal,
			workspot: options.workspot ?? original.workspot,
			timestamp: new Date(Math.max(Date.now(), latestTime + 1)).toISOString(),
			lifecycle: "draft",
			assertion: original.assertion,
			verification: original.verification,
			artifact: {
				...original.artifact,
				targetRef: options.targetRef ?? original.artifact.targetRef,
			},
			artifactOrigin: original.artifactOrigin,
			revalidates: rootId,
			writerId: original.writerId,
			threadId: original.threadId,
		});
		await bb.checkpoints.save(cp, "staging");
		await bb.events.append({
			timestamp: cp.timestamp,
			source: "runtime",
			type: "artifact_revalidation_requested",
			payload: { rootId, cpId: cp.id, workspot: cp.workspot },
		});
		await verifyCheckpoint(bb, cp.id, []);
		await reconcileArtifacts(bb);
		return Object.values(await bb.checkpoints.scanAll())
			.flat()
			.find((entry) => entry.id === cp.id)!;
	} finally {
		await lock.release();
	}
}
