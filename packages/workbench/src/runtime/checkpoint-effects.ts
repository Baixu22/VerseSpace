import { isDeepStrictEqual } from "node:util";
import { checkArtifactUse } from "../artifacts/use-guard";
import type { Blackboard } from "../blackboard";
import type { Checkpoint } from "../types/checkpoint";
import {
	type RegistryEntry,
	type RegistryUpdate,
	registryEntrySchema,
	registryUpdateSchema,
} from "../types/interface-registry";
import { event } from "./events";
import type { RuntimeNotification } from "./types";

async function planUpdates(bb: Blackboard, checkpoint: Checkpoint) {
	const effects = checkpoint.blackboardEffects;
	if (effects?.publish.length) {
		throw new Error(
			"checkpoint publish 缺少完整注册信息；请先通过 interface register 创建接口",
		);
	}
	const patches = new Map<string, RegistryUpdate>();
	for (const change of effects?.update ?? []) {
		const patch = registryUpdateSchema.parse({ [change.field]: change.value });
		patches.set(change.key, { ...patches.get(change.key), ...patch });
	}
	const plans: Array<{ before: RegistryEntry; patch: RegistryUpdate }> = [];
	for (const [key, patch] of patches) {
		const before = await bb.interfaces.getEntry(key);
		if (!before) throw new Error(`checkpoint update 的接口未注册：${key}`);
		registryEntrySchema.parse({ ...before, ...patch });
		plans.push({ before, patch });
	}
	return plans;
}

/** Persist recovery data first; only publish applied after every effect succeeds. */
export async function applyCheckpoint(
	bb: Blackboard,
	checkpoint: Checkpoint,
	notifications: RuntimeNotification[],
	options: { evidenceId?: string } = {},
): Promise<{ ok: boolean; reason?: string }> {
	let candidate = checkpoint;
	let consumptionStarted = false;
	if (checkpoint.artifact) {
		const use = await checkArtifactUse(bb, checkpoint, options.evidenceId);
		if (!use.ok) {
			await event(bb, "artifact_use_rejected", use);
			if (checkpoint.lifecycle !== "applied" && !checkpoint.artifactConsumption)
				await bb.checkpoints.save(
					{ ...checkpoint, artifactUseIssue: use.reason },
					"verified",
				);
			notifications.push({
				severity: "warning",
				message: `产物验收拒绝：${use.reason}；可正常编辑并重验后显式 consume`,
			});
			return { ok: false, reason: use.reason };
		}
		candidate = {
			...checkpoint,
			artifactConsumption: use.receipt,
			artifactUseIssue: undefined,
		};
	}
	try {
		// Validate the entire batch before the first write. The runtime does not
		// promise a multi-file transaction; failures preserve the recovery data.
		const plans = await planUpdates(bb, checkpoint);
		if (plans.length > 0) {
			candidate = {
				...candidate,
				rollback: {
					...checkpoint.rollback,
					context: {
						...Object.fromEntries(
							plans.map(({ before }) => [before.key, before]),
						),
						...checkpoint.rollback?.context,
					},
				},
			};
		}
		// A durable started receipt prevents replay after a crash between registry
		// writes. It is not a claim that the effects have finished.
		if (plans.length > 0 || candidate.artifactConsumption) {
			await bb.checkpoints.save(candidate, "verified");
			consumptionStarted = !!candidate.artifactConsumption;
		}
		for (const { before, patch } of plans) {
			if (
				Object.entries(patch).every(([key, value]) =>
					isDeepStrictEqual(before[key as keyof RegistryEntry], value),
				)
			)
				continue;
			await bb.interfaces.updateEntry(before.key, patch, {
				expectedVersion: before.version,
			});
		}
		if (candidate.artifactConsumption)
			candidate = {
				...candidate,
				artifactConsumption: {
					...candidate.artifactConsumption,
					state: "applied",
				},
			};
		await event(bb, "checkpoint_applied", {
			cpId: checkpoint.id,
			effects: checkpoint.blackboardEffects,
			...(candidate.artifactConsumption
				? { consumption: candidate.artifactConsumption }
				: {}),
		});
		await bb.checkpoints.save(
			{ ...candidate, lifecycle: "applied", applicationError: undefined },
			"verified",
		);
		return { ok: true };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await bb.checkpoints.save(
			{
				...candidate,
				artifactConsumption: consumptionStarted
					? { ...candidate.artifactConsumption!, state: "started" }
					: undefined,
				lifecycle: "failed",
				applicationError: message,
			},
			"verified",
		);
		await bb.checkpoints.move(checkpoint.id, "verified", "failed");
		await event(bb, "checkpoint_apply_failed", {
			cpId: checkpoint.id,
			reason: message,
		});
		notifications.push({
			severity: "error",
			message: `checkpoint ${checkpoint.id} 应用失败：${message}`,
		});
		return { ok: false, reason: message };
	}
}
