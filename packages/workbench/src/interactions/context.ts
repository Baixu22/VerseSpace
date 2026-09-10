import type { Blackboard } from "../blackboard";
import type { WorkbenchEvent } from "../types/event";
import { computeDoi } from "./doi";
import { projectLandmarks } from "./project";
import {
	CONTENT_TYPES,
	INTERACTION_WEIGHT,
	INTERACTIONS_SOURCE,
	INTERACTIONS_TYPE,
	type InteractionEvent,
} from "./types";

async function writerEvents(bb: Blackboard, writer: string) {
	if (!(await bb.sessions.get(writer)))
		throw new Error(`写者未注册：${writer}`);
	const records = await bb.events.query({
		source: INTERACTIONS_SOURCE,
		type: INTERACTIONS_TYPE,
	});
	return writerInteractionEvents(records, writer);
}

function writerInteractionEvents(records: WorkbenchEvent[], writer: string) {
	return records.filter((event) => {
		const item = event.payload as Partial<InteractionEvent> | null;
		return (
			event.source === INTERACTIONS_SOURCE &&
			event.type === INTERACTIONS_TYPE &&
			item &&
			item.origin === writer &&
			typeof item.handle === "string" &&
			typeof item.time === "string" &&
			Number.isFinite(Date.parse(item.time)) &&
			typeof item.kind === "string" &&
			Object.hasOwn(INTERACTION_WEIGHT, item.kind) &&
			CONTENT_TYPES.includes(item.contentType!) &&
			typeof item.delta === "number"
		);
	});
}

/** Read-only context surface plus the manual-reduction tuning signal (TF-0110). */
export async function collectInterest(bb: Blackboard, writer: string) {
	const records = await writerEvents(bb, writer);
	return interestFromEvents(records, writer);
}

/** Shared read-only projection for CLI context and stats from one log snapshot. */
export function interestFromEvents(
	records: WorkbenchEvent[],
	writer: string,
	now = Date.now(),
) {
	const scoped = writerInteractionEvents(records, writer);
	const events = scoped.map((event) => event.payload as InteractionEvent);
	const result = computeDoi(events, now);
	const reductions = scoped.filter(
		(event) => (event.payload as InteractionEvent).kind === "interest-reduced",
	);
	const byHandle: Record<string, number> = {};
	for (const event of reductions) {
		const handle = (event.payload as InteractionEvent).handle;
		byHandle[handle] = (byHandle[handle] ?? 0) + 1;
	}
	return {
		writer,
		landmarks: projectLandmarks(result, events),
		/**
		 * 真地标 handle（DOI > landmarkFloor），L1 的分母（positioning-v6 §11
		 * 「地标集合（DOI>10）」）。必须与上面的投影分开：投影在没有真地标时会
		 * 回退到可见集 top-N（列表永不为空），那张回退表里有目录和项目根，
		 * 但它不是地标集合——拿回退表当分母，L1 量的就是「显示了什么」而不是
		 * 「地标的命中率」（2026-09-11 实测：租户 95 个写者里 27 个只有回退表，
		 * 占当时分母的 96%）。
		 */
		landmarkHandles: result.landmarks,
		visible: result.visible,
		reductions: {
			total: reductions.length,
			lastAt: reductions.at(-1)?.timestamp ?? null,
			byHandle,
		},
	};
}

/** Append one reversible attention adjustment; file contents are never touched. */
export async function lowerInterest(
	bb: Blackboard,
	writer: string,
	handle: string,
) {
	const records = await writerEvents(bb, writer);
	const events = records.map((event) => event.payload as InteractionEvent);
	const now = new Date();
	const normalized = handle.trim().replace(/\\/g, "/").replace(/^\.\//, "");
	const score = computeDoi(events, now.getTime()).scores.get(normalized);
	if (!score) throw new Error(`没有已观察到的条目：${normalized}`);
	if (!score.visible)
		return { recorded: false, handle: normalized, eventId: null };
	const payload: InteractionEvent = {
		time: now.toISOString(),
		kind: "interest-reduced",
		origin: writer,
		contentType: score.contentType,
		handle: normalized,
		delta: 0,
	};
	const event = await bb.events.append({
		timestamp: payload.time,
		source: INTERACTIONS_SOURCE,
		type: INTERACTIONS_TYPE,
		payload,
	});
	return { recorded: true, handle: normalized, eventId: event.id ?? null };
}
