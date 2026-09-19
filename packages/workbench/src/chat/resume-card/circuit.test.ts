import { expect, test } from "bun:test";
import {
	CIRCUIT_DISMISS_LIMIT,
	CIRCUIT_MIN_SAMPLES,
	CIRCUIT_WINDOW,
	type ResumeCardCircuitState,
	resumeCardCircuit,
} from "./circuit";
import type { LifecycleEventLike } from "./dismissal";

let seq = 0;
function ev(
	type: string,
	threadId: string,
	extra: Record<string, unknown> = {},
): LifecycleEventLike {
	seq += 1;
	return { type, eventSeq: seq, payload: { threadId, ...extra } };
}

const dismiss = (threadId: string) =>
	ev("thread.resume_action", threadId, { action: "resume_card_dismissed" });
const consume = (threadId: string) =>
	ev("thread.resume_action", threadId, { action: "resume_fact_opened" });
const restore = (threadId: string) => ev("thread.restored", threadId);

function state(events: LifecycleEventLike[]): ResumeCardCircuitState {
	return resumeCardCircuit(events);
}

test("无样本：closed 且 dismissRate=null——不可计算不是 0", () => {
	const noOutcomes = state([restore("t")]);
	expect(noOutcomes.samples).toBe(0);
	expect(noOutcomes.dismissRate).toBeNull();
	expect(noOutcomes.state).toBe("closed");
	// 历史末尾未关窗的观察也结算：一次消费是结局，rate=0（closed）。
	const oneConsume = state([restore("t"), consume("t")]);
	expect(oneConsume.samples).toBe(1);
	expect(oneConsume.dismissRate).toBe(0);
});

test("样本不足不熔断：连续 dismiss 也只是一种样本，单次不是证据", () => {
	const few = state([restore("t"), dismiss("t"), restore("t"), dismiss("t")]);
	expect(few.samples).toBe(CIRCUIT_MIN_SAMPLES - 1);
	expect(few.dismissRate).toBe(1);
	expect(few.state).toBe("closed");
});

test("dismiss 率 >50% 且样本足：open——stats 的降级记录", () => {
	const events: LifecycleEventLike[] = [];
	for (let i = 0; i < CIRCUIT_MIN_SAMPLES; i += 1) {
		events.push(restore("t"), dismiss("t"));
	}
	const tripped = state(events);
	expect(tripped.state).toBe("open");
	expect(tripped.dismissed).toBe(CIRCUIT_MIN_SAMPLES);
	expect(tripped.dismissRate).toBe(1);
});

test("恰好 50% 不熔断（开区间），消费过的卡片不算负样本", () => {
	const events: LifecycleEventLike[] = [];
	for (let i = 0; i < 3; i += 1) {
		events.push(restore("t"), dismiss("t"));
	}
	for (let i = 0; i < 3; i += 1) {
		events.push(restore("t"), consume("t"));
	}
	const boundary = state(events);
	expect(boundary.dismissRate).toBe(CIRCUIT_DISMISS_LIMIT);
	expect(boundary.state).toBe("closed");

	// 展开后又 dismiss：同一个观察窗里发生过消费，记 consumed——不是负样本。
	const engaged = state([restore("t"), consume("t"), dismiss("t")]);
	expect(engaged.dismissed).toBe(0);
	expect(engaged.consumed).toBe(1);
	expect(engaged.state).toBe("closed");
	// 但消费不护短：之后的恢复只 dismiss，负样本照实累计。
	const later = state([
		restore("t"),
		consume("t"),
		dismiss("t"),
		restore("t"),
		dismiss("t"),
		restore("t"),
		dismiss("t"),
		restore("t"),
		dismiss("t"),
	]);
	expect(later.consumed).toBe(1);
	expect(later.dismissed).toBe(3);
	expect(later.state).toBe("open");
});

test("熔断可恢复：dismiss 潮后接消费潮，state 回到 closed", () => {
	const events: LifecycleEventLike[] = [];
	for (let i = 0; i < CIRCUIT_MIN_SAMPLES; i += 1) {
		events.push(restore("t"), dismiss("t"));
	}
	expect(state(events).state).toBe("open");
	for (let i = 0; i < CIRCUIT_MIN_SAMPLES; i += 1) {
		events.push(restore("t"), consume("t"));
	}
	const recovered = state(events);
	expect(recovered.state).toBe("closed");
	expect(recovered.dismissRate).toBe(CIRCUIT_DISMISS_LIMIT);
	// 恢复不需要任何额外手势——同一份历史，读法变了状态就变。
	expect(state(events).state).toBe("closed");
});

test("切走关窗：switch 后的 dismiss 不计入任何窗口", () => {
	const events = [
		restore("t"),
		consume("t"),
		ev("thread.switch", "t", { fromThreadId: null }),
		dismiss("t"),
		restore("t"),
		dismiss("t"),
		restore("t"),
		dismiss("t"),
	];
	const mixed = state(events);
	expect(mixed.consumed).toBe(1);
	expect(mixed.dismissed).toBe(2);
	// 3 个样本里 2 个 dismiss → 0.6667 > 0.5 → open（窗口内的真实信号）。
	expect(mixed.state).toBe("open");
});

test("窗口只看最近 N 个结局：老消费滑出后，dismiss 潮照常熔断", () => {
	const events: LifecycleEventLike[] = [];
	// 先攒 8 个消费结局。
	for (let i = 0; i < 8; i += 1) {
		events.push(restore("t"), consume("t"));
	}
	// 3 个 dismiss：最近 10 个结局里 3 dismiss / 7 consume = 0.3 → closed。
	for (let i = 0; i < 3; i += 1) {
		events.push(restore("t"), dismiss("t"));
	}
	const slid = state(events);
	expect(slid.samples).toBe(CIRCUIT_WINDOW);
	expect(slid.dismissed).toBe(3);
	expect(slid.state).toBe("closed");
	// 旧结局陆续滑出：5 dismiss / 5 consume = 0.5（开区间，不动），
	// 再滑到 6 / 4 = 0.6 → open。同一份历史，窗口滑到哪算到哪。
	events.push(restore("t"), dismiss("t"), restore("t"), dismiss("t"));
	expect(state(events).state).toBe("closed");
	expect(state(events).dismissRate).toBe(CIRCUIT_DISMISS_LIMIT);
	events.push(restore("t"), dismiss("t"));
	const tripped = state(events);
	expect(tripped.dismissed).toBe(6);
	expect(tripped.consumed).toBe(4);
	expect(tripped.state).toBe("open");
});
