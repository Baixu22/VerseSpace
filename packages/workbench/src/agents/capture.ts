import { resolve } from "node:path";
import type { Blackboard } from "../blackboard";
import {
	extractFootprint,
	hashPathClaim,
	type ParsedStreamFootprint,
} from "../blackboard/footprint";
import { writerSpoolDir } from "../blackboard/sessions";
import { foldAndAssess } from "../tribunal/lane-distress";
import { extractUsage } from "./usage";

/** Capture one batch agent's stream before publishing its terminal status. */
export async function createAgentCapture(
	bb: Blackboard,
	writerId: string,
	workspotId: string,
	worktree: string,
) {
	const pending = new Map<string, ParsedStreamFootprint>();
	let queue: Promise<void> = Promise.resolve();
	let laneMetrics = await bb.metrics.get(workspotId);
	let dirty = false;
	let resultError: string | undefined;
	let recordingError: unknown;

	function enqueue(work: () => Promise<void>): void {
		queue = queue.then(work).catch((error) => {
			recordingError ??= error;
		});
	}

	async function flushUsage(): Promise<void> {
		if (!dirty) return;
		dirty = false;
		await bb.metrics.save(workspotId, laneMetrics);
	}

	function line(raw: string): void {
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			return;
		}
		const sample = extractUsage(event);
		if (sample) {
			if (sample.failed) {
				resultError =
					typeof event.result === "string" && event.result.trim()
						? event.result
						: "agent 回合执行失败";
			}
			const folded = foldAndAssess(laneMetrics, sample);
			laneMetrics = folded.lane;
			dirty = true;
			if (event.type === "result") enqueue(flushUsage);
			if (folded.distress.length > 0) {
				enqueue(async () => {
					for (const item of folded.distress) {
						await bb.tribunal.submit(item.envelope);
					}
				});
			}
		}

		const message = event.message as
			| { content?: Array<Record<string, unknown>> }
			| undefined;
		const content = Array.isArray(message?.content) ? message.content : [];
		if (event.type === "assistant") {
			for (const block of content) {
				if (block.type !== "tool_use") continue;
				// The extractor returns one call; a stream event may contain many.
				const fp = extractFootprint(
					{ ...event, message: { content: [block] } },
					writerId,
				);
				if (!fp) continue;
				pending.set(fp.activity, fp);
				enqueue(async () => {
					for (const used of fp.used) {
						Object.assign(
							used,
							await hashPathClaim(
								bb.projectRoot,
								resolve(worktree, used.path),
								writerSpoolDir(bb.paths, writerId),
								used.span,
							),
						);
					}
				});
			}
		} else if (event.type === "user") {
			for (const block of content) {
				if (block.type !== "tool_result") continue;
				const toolCallId = String(block.tool_use_id ?? "");
				const fp = pending.get(toolCallId);
				if (!fp) continue;
				pending.delete(toolCallId);
				// A rejected tool did not observe or generate the requested file.
				if (block.is_error === true) continue;
				enqueue(async () => {
					for (const gen of fp.generated) {
						Object.assign(
							gen,
							await hashPathClaim(bb.projectRoot, resolve(worktree, gen.path)),
						);
					}
					await bb.sessions.recordActivity(writerId, fp);
				});
			}
		}
	}

	return {
		line,
		async finish(): Promise<string | undefined> {
			await queue;
			if (recordingError) throw recordingError;
			await flushUsage();
			for (const fp of pending.values()) {
				await bb.sessions.recordActivity(writerId, fp);
			}
			pending.clear();
			return resultError;
		},
	};
}
