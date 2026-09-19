/**
 * Blackboard event log entry (events.jsonl). The payload is intentionally
 * open: any world module may append structured events. `id` and `eventSeq`
 * are written once and never derived from the order in which a reader happens
 * to load the file. `seq` remains a physical-line compatibility view.
 */
export interface WorkbenchEvent {
	timestamp: string;
	source: string;
	type: string;
	payload: unknown;
	/** Stable event identity. Old logs may omit it and get a deterministic view id. */
	id?: string;
	/** Stable causal sequence assigned while holding the append lock. */
	eventSeq?: number;
	/** Physical non-empty line number (legacy/read-side compatibility). */
	seq?: number;
}

export type EventToAppend = Omit<WorkbenchEvent, "seq" | "eventSeq"> & {
	/** Callers may provide an id when another append-only store needs a join key. */
	id?: string;
};

export const THREAD_EVENT_SOURCE = "threads" as const;

/** Lifecycle events are observations, never state-machine conclusions. */
export const THREAD_EVENT_TYPES = new Set([
	"thread.created",
	"thread.forked",
	"thread.left",
	"thread.restored",
	"thread.switch",
	"thread.resume_note_consumed",
	"thread.inheritance_observed",
	"thread.resume_action",
	// 分支摘要折回（TF-0196，恢复 TF-0132 的白名单半成品）：观察「子分支的
	// 结构摘要已并入父线程恢复面」这一事实。仍然只是观察——结论键照常拒绝，
	// 摘要内容以 refs 溯源，不自带裁决。
	"thread.merged_back",
	// 恢复卡展示观测（TF-0199）：UI 报告「这次恢复面渲染了哪些分支行」——
	// fit 指标 7（渲染的分支行中被展开或被点的比例）的分母。渲染是真实
	// 发生的展示，不是手势：单独成类，不混进 resume_action（否则「返回后
	// 第一动作」会被渲染事件污染）。
	"thread.resume_card_shown",
	// 收养（TF-0200）：观察「子线程被提升为主线、源线程就地归档」这一身份
	// 迁移事实。仍是观察——不搬内容、不带裁决，refs 溯源回指触发手势的来源，
	// snapshotVersion 供反转定位快照。
	"thread.adopted",
]);

const FORBIDDEN_THREAD_KEYS = new Set([
	"status",
	"verdict",
	"done",
	"passed",
	"success",
	"completed",
]);

function hasForbiddenKey(
	value: unknown,
	seen = new Set<object>(),
): string | null {
	if (!value || typeof value !== "object") {
		return null;
	}
	if (seen.has(value)) {
		return null;
	}
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = hasForbiddenKey(item, seen);
			if (found) {
				return found;
			}
		}
		return null;
	}
	for (const [key, child] of Object.entries(value)) {
		if (FORBIDDEN_THREAD_KEYS.has(key)) {
			return key;
		}
		const found = hasForbiddenKey(child, seen);
		if (found) {
			return found;
		}
	}
	return null;
}

/** Throw at the trust boundary if a session event tries to carry a verdict. */
export function validateThreadEvent(
	type: string,
	payload: unknown,
): asserts payload is Record<string, unknown> {
	if (!THREAD_EVENT_TYPES.has(type)) {
		throw new Error(`未知线程生命周期事件：${type}`);
	}
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new Error("线程生命周期事件 payload 必须是对象");
	}
	const body = payload as Record<string, unknown>;
	if (typeof body.threadId !== "string" || body.threadId.length === 0) {
		throw new Error("线程生命周期事件缺少 threadId");
	}
	if (
		body.refs !== undefined &&
		(!Array.isArray(body.refs) ||
			body.refs.some((ref) => typeof ref !== "string"))
	) {
		throw new Error("线程生命周期事件 refs 必须是字符串数组");
	}
	const forbidden = hasForbiddenKey(body);
	if (forbidden) {
		throw new Error(`线程生命周期事件不得携带状态字段：${forbidden}`);
	}
}

/** World folds may consume facts, but never session topology observations. */
export function isWorldEvent(
	event: Pick<WorkbenchEvent, "source" | "type">,
): boolean {
	return (
		event.source !== THREAD_EVENT_SOURCE && !event.type.startsWith("thread.")
	);
}

export interface EventFilter {
	type?: string;
	source?: string;
	limit?: number;
}
