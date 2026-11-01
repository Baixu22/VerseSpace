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
	// 协议切换（阶段二）：观察「本轮因协议变化分叉」与「绑定目标变化」两个事实。
	"thread.protocol_forked",
	"thread.binding_changed",
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
	// 收养反转（TF-0200）：观察「快照被消费、双方身份复归」这一事实。与
	// thread.adopted 对称——仍是观察，snapshotId 回指被消费的快照。
	"thread.adoption_reverted",
	// 回合中断（会话延续性）：启动清扫发现 meta 仍停在 running，说明上一个
	// 宿主进程在回合中途消失。复位之前先落这条观察——否则「这一轮被切断」
	// 会随着 status 复位一起被抹掉，恢复面只剩一条没有回复的人类消息。
	// 仍然只是观察：中断不代表失败，之后有助手消息回答即视为已回来。
	"thread.turn_interrupted",
	// 用户主动停止（阶段三 TF-0330）：UI 或 CLI 调 `cancel` 中止了当前回合。
	// 这条是**有意终止**而不是被切断——它让「末条是人类消息、没有回复」不再
	// 一律读成待办：人自己按了停，就不是需要别人看一眼的断点。仍只是观察。
	"thread.turn_cancelled",
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
		event.source !== "capture" &&
		event.source !== THREAD_EVENT_SOURCE &&
		!event.type.startsWith("thread.")
	);
}

export interface EventFilter {
	type?: string;
	source?: string;
	limit?: number;
}
