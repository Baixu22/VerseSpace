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

/**
 * 一段交互的参考时刻：取该写者**自己最后一条事件**的时间。
 *
 * 为什么不能直接用「现在」：DOI = Σ权重 − 衰减，(now − 事件时间) 的小时数直接
 * 进减项，于是同一段会话的地标集合会**随着时间流逝自己缩小**——今天算出来是
 * 地标，下周再算就跌到线下。§11 问的是「一段会话结束后，系统能列出该会话的
 * 地标集合」，参考时刻就该是那段会话自己的末尾；这样验收读数才是可复现的
 * （跨四个真实现场实测：会话时钟把 node-verified 现场从 0 条拉到 4 条、floor=4
 * 时写者覆盖 24 → 47，租户的出厂读数不变；也就是说衰减不是主因，绝对阈值才是）。
 *
 * **只给「判定一段会话干的是什么」的路径用**（L1 认可率、账本、标定扫描）。
 * 实时上下文显示不能走它：那里的衰减是有意的（几天没碰的文件就该离开上下文），
 * 用会话时钟会让陈旧文件永远留在 `visible` 里。所以默认仍是「现在」，
 * 需要稳定的判定路径显式传 `{ clock: "session" }`。
 */
function sessionClock(events: InteractionEvent[], fallback: number): number {
	let latest = 0;
	for (const event of events) {
		const at = Date.parse(event.time);
		if (Number.isFinite(at) && at > latest) latest = at;
	}
	return latest > 0 ? latest : fallback;
}

/**
 * 相对选择：**该会话自己**按 DOI 排出来的文件级 top-K（TF-0156 验收三）。
 *
 * 为什么要另一条规则：绝对阈值（DOI > landmarkFloor）要求「同一条 handle 在衰减
 * 窗口内被推过 10 分」，而真实形状是很多文件各被碰一两次（权重 1–2），跨四个现场
 * 实测有三个直接空集——于是 L1 的分母常常是空的，判据无法计算。相对选择只在
 * 「这个会话一个文件都没碰」时才为空：租户 78/103、节点验证 32/32、LHA3I4 15/16、
 * VAKSgQ 12/13 非空（写者覆盖 76%/100%/94%/92%）。
 *
 * 排序用**会话时钟**下的 DOI：会话内事件相隔秒级，衰减几乎均匀，所以次序反映的是
 * 触碰权重（编辑 vs 选中）而不是「谁离现在近」。同分按 handle 字典序，保证可复现。
 *
 * 分两步导出：只取 handle 的 `sessionFileTopK`，与带分数的 `sessionFileScores`
 * （复核队列的抽样依据「会话 DOI 总分降序」要用分数，不能拿 handle 反推）。
 */
export function sessionFileScores(
	records: WorkbenchEvent[],
	writer: string,
	now = Date.now(),
): Array<{ handle: string; doi: number }> {
	const scoped = writerInteractionEvents(records, writer);
	const events = scoped.map((event) => event.payload as InteractionEvent);
	const result = computeDoi(events, sessionClock(events, now));
	return [...result.scores.entries()]
		.filter(([, score]) => score.contentType === "file")
		.sort((a, b) => b[1].doi - a[1].doi || a[0].localeCompare(b[0]))
		.map(([handle, score]) => ({ handle, doi: score.doi }));
}

export function sessionFileTopK(
	records: WorkbenchEvent[],
	writer: string,
	k: number,
	now = Date.now(),
): string[] {
	return sessionFileScores(records, writer, now)
		.slice(0, k)
		.map((row) => row.handle);
}

/** Shared read-only projection for CLI context and stats from one log snapshot. */
export function interestFromEvents(
	records: WorkbenchEvent[],
	writer: string,
	now = Date.now(),
	options: { clock?: "now" | "session" } = {},
) {
	const scoped = writerInteractionEvents(records, writer);
	const events = scoped.map((event) => event.payload as InteractionEvent);
	const reference =
		options.clock === "session" ? sessionClock(events, now) : now;
	const result = computeDoi(events, reference);
	const reductions = scoped.filter(
		(event) => (event.payload as InteractionEvent).kind === "interest-reduced",
	);
	const byHandle: Record<string, number> = {};
	for (const event of reductions) {
		const handle = (event.payload as InteractionEvent).handle;
		byHandle[handle] = (byHandle[handle] ?? 0) + 1;
	}
	/**
	 * L1 的单位是文件级地标：目录（含项目根 `.`）也在 DOI 集合里，但它们不能被
	 * 人回答成「这次干的活的核心」。2026-09-11 跨四个真实现场实测，地标集合里
	 * 目录占 33%–75%，且阈值越低占比越高（现场 A：floor=10 → 40%，floor=6 → 75%）
	 * ——所以「调低阈值提高覆盖」这条路会把分母越调越脏。文件级是本轮的数据结论。
	 */
	const fileLandmarks = result.landmarks.filter(
		(handle) => result.scores.get(handle)?.contentType === "file",
	);
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
		/**
		 * 文件级地标：L1 实际用的分母（上面那条注释说的是「不能拿投影当分母」，
		 * 这条说的是「不能把目录算进分母」）。想知道目录被排除了多少，用
		 * `landmarkHandles.length - fileLandmarkHandles.length`。
		 */
		fileLandmarkHandles: fileLandmarks,
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
