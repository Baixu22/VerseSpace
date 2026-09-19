/**
 * 恢复卡熔断器（TF-0198）：dismiss 率 >50% 自动把分支行降为 L0 指针。
 *
 * D3-Q2 的回注稀释熔断（D4 失败 5）：分支动静是给恢复用的信号，不是装饰。
 * 连续被关掉而不被消费，说明它在稀释主线——降级，等行为变了再恢复。
 *
 * 读法是一条事件投影（与 isResumeCardDismissed 同一输入形状）：每次
 * `thread.restored` 开一个该线程的观察窗，窗内收集 `thread.resume_action`；
 * 下一次恢复、切走（`thread.switch`）或离开（`thread.left`）关窗并结算
 * ——有消费动作（展开事实/打开分支）记 consumed，只有 dismiss 记
 * dismissed。展开后又 dismiss 是「消费过的卡片」，不算负样本。
 *
 * 纯投影：读历史即可算出当前状态，所以「恢复」不需要任何额外手势——
 * 近窗行为变好，state 自己回到 closed。stats 读它得到降级记录，渲染路径
 * 读它决定 L1/L0，两处共用同一函数，口径不会分家。
 */
import type { LifecycleEventLike } from "./dismissal";

/** 结算窗口：最近 N 个有结局的恢复。 */
export const CIRCUIT_WINDOW = 10;
/** 少于这么多有结局的恢复不熔断——单次 dismiss 不是证据。 */
export const CIRCUIT_MIN_SAMPLES = 3;
/** dismiss 率熔断线（开区间：> 才熔断，恰好 50% 不动）。 */
export const CIRCUIT_DISMISS_LIMIT = 0.5;

const CONSUMPTION_ACTIONS = new Set([
	"resume_fact_opened",
	"resume_branch_opened",
]);

export interface ResumeCardCircuitState {
	/** open = 分支行降为 L0 指针；closed = L1 结构摘要照常。 */
	state: "open" | "closed";
	/** 窗口内 dismiss 结局占比；null = 无样本（不可计算，不是 0）。 */
	dismissRate: number | null;
	samples: number;
	dismissed: number;
	consumed: number;
	window: number;
	minSamples: number;
	limit: number;
}

function payloadOf(event: LifecycleEventLike): Record<string, unknown> {
	return event.payload && typeof event.payload === "object"
		? (event.payload as Record<string, unknown>)
		: {};
}

interface ObservationWindow {
	dismissed: boolean;
	consumed: boolean;
}

export function resumeCardCircuit(
	events: LifecycleEventLike[],
): ResumeCardCircuitState {
	const outcomes: ("dismissed" | "consumed")[] = [];
	const open = new Map<string, ObservationWindow>();
	const close = (threadId: string): void => {
		const window = open.get(threadId);
		if (!window) return;
		open.delete(threadId);
		if (window.consumed) {
			outcomes.push("consumed");
		} else if (window.dismissed) {
			outcomes.push("dismissed");
		}
	};
	for (const event of events) {
		if (event.type === "thread.switch" || event.type === "thread.left") {
			// 换车道/离开结束所有在途观察：窗口后的动作不属于这次恢复。
			for (const threadId of [...open.keys()]) close(threadId);
			continue;
		}
		const payload = payloadOf(event);
		if (event.type === "thread.restored") {
			const threadId =
				typeof payload.threadId === "string" ? payload.threadId : null;
			if (threadId) {
				close(threadId);
				// 新的恢复 = 该线程新的观察窗。
				open.set(threadId, { dismissed: false, consumed: false });
			}
			continue;
		}
		if (event.type !== "thread.resume_action") continue;
		const threadId =
			typeof payload.threadId === "string" ? payload.threadId : null;
		if (!threadId || !open.has(threadId)) continue;
		const action = typeof payload.action === "string" ? payload.action : "";
		if (action === "resume_card_dismissed") {
			open.get(threadId)!.dismissed = true;
		}
		if (CONSUMPTION_ACTIONS.has(action)) {
			open.get(threadId)!.consumed = true;
		}
	}
	for (const threadId of [...open.keys()]) close(threadId);

	const recent = outcomes.slice(-CIRCUIT_WINDOW);
	const dismissed = recent.filter((outcome) => outcome === "dismissed").length;
	const consumed = recent.length - dismissed;
	const dismissRate =
		recent.length > 0 ? Number((dismissed / recent.length).toFixed(4)) : null;
	const tripped =
		recent.length >= CIRCUIT_MIN_SAMPLES &&
		dismissRate != null &&
		dismissRate > CIRCUIT_DISMISS_LIMIT;
	return {
		state: tripped ? "open" : "closed",
		dismissRate,
		samples: recent.length,
		dismissed,
		consumed,
		window: CIRCUIT_WINDOW,
		minSamples: CIRCUIT_MIN_SAMPLES,
		limit: CIRCUIT_DISMISS_LIMIT,
	};
}
