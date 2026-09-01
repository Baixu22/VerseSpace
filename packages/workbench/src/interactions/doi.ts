/**
 * Mylyn DOI（Degree-Of-Interest，含重置规则与生命周期自适应常数）— TF-0088。
 *
 * 模型：DOI = Σ weight(kind) − 自上次触碰以来的衰减。
 *
 * 与 Mylyn 的两处关键差异（修它没修的洞，TF-0088 execution_hints）：
 *  1. 衰减重置：衰减到负的元素一被触碰就立刻转正，不必从 −N 爬回。
 *     触碰时 score = max(score, 0) + weight。
 *  2. 生命周期自适应：Mylyn 只有一套全局常数，导致年轻任务里该保留的
 *     兴趣被过度衰减（用户狂点『降低兴趣』），成熟任务里该衰减的残留
 *     仍可见（2.06% 选择落在已衰减出视野的元素上）。本实现让衰减率与
 *     父级传播份额随『上下文年龄』滑动：年轻慢衰减宽搜索，成熟快衰减窄搜索。
 *
 * 阈值：DOI > visibleFloor 可见；DOI > landmarkFloor 地标；≤ visibleFloor 完全过滤。
 * 父级传播：文件 → 目录 → 项目根，逐级 × parentShare（指数衰减）。
 *
 * 纯函数，无 IO：输入交互事件流（TF-0087 的 InteractionEvent[]），输出各
 * handle 的 DOI 分类。上下文年龄 = 事件流首条时间到当前时间的跨度。
 */

import type { ContentType, InteractionEvent, InteractionKind } from "./types";

export interface DoiConfig {
	/** 每种交互的权重：selection=1, edit=2, command=0（出厂常数）。 */
	weight: Record<InteractionKind, number>;
	/** 基础衰减率（每小时）。出厂 0.1。 */
	decayPerHour: number;
	/** 可见阈值：DOI > visibleFloor 可见；≤ 完全过滤。出厂 0。 */
	visibleFloor: number;
	/** 地标阈值：DOI > landmarkFloor 是地标。出厂 10。 */
	landmarkFloor: number;
	/**
	 * 生命周期分档（毫秒）：上下文年龄 < youngAgeMs 视为年轻，
	 * > matureAgeMs 视为成熟，中间线性插值。
	 */
	youngAgeMs: number;
	matureAgeMs: number;
	/** 年轻端：衰减缩放（<1 慢衰减）与父级传播份额（高 = 宽搜索）。 */
	youngDecayScale: number;
	youngParentShare: number;
	/** 成熟端：衰减缩放（>1 快衰减）与父级传播份额（低 = 窄搜索）。 */
	matureDecayScale: number;
	matureParentShare: number;
}

export const DEFAULT_DOI_CONFIG: DoiConfig = {
	weight: { selection: 1, edit: 2, command: 0 },
	decayPerHour: 0.1,
	visibleFloor: 0,
	landmarkFloor: 10,
	youngAgeMs: 10 * 60_000, // 10 分钟
	matureAgeMs: 60 * 60_000, // 1 小时
	youngDecayScale: 0.5, // 年轻：衰减减半
	youngParentShare: 0.7, // 年轻：兴趣向父级宽传播
	matureDecayScale: 2, // 成熟：衰减翻倍
	matureParentShare: 0.3, // 成熟：兴趣向父级窄传播
};

export interface DoiScore {
	handle: string;
	contentType: ContentType;
	doi: number;
	/** 是否地标（DOI > landmarkFloor）。 */
	landmark: boolean;
	/** 是否可见（DOI > visibleFloor）。 */
	visible: boolean;
	/** 最近一次触碰时间（epoch ms）。 */
	lastTouchAt: number;
	/** 触碰次数（含父级传播的间接触碰）。 */
	touchCount: number;
}

export interface DoiResult {
	/** 全部 handle（含父级传播产生）的分数。 */
	scores: Map<string, DoiScore>;
	/** 地标 handle，按 DOI 降序。 */
	landmarks: string[];
	/** 可见 handle（含地标），按 DOI 降序。 */
	visible: string[];
}

interface HandleState {
	score: number;
	lastTouch: number;
	touches: number;
	contentType: ContentType;
}

const MS_PER_HOUR = 3_600_000;

/** 上下文年龄对应的时间缩放与父级传播份额（年轻↔成熟线性插值）。 */
function lifecycleAt(
	ageMs: number,
	config: DoiConfig,
): { scale: number; share: number } {
	if (ageMs <= config.youngAgeMs) {
		return { scale: config.youngDecayScale, share: config.youngParentShare };
	}
	if (ageMs >= config.matureAgeMs) {
		return { scale: config.matureDecayScale, share: config.matureParentShare };
	}
	const t =
		(ageMs - config.youngAgeMs) / (config.matureAgeMs - config.youngAgeMs);
	return {
		scale:
			config.youngDecayScale +
			(config.matureDecayScale - config.youngDecayScale) * t,
		share:
			config.youngParentShare +
			(config.matureParentShare - config.youngParentShare) * t,
	};
}

/** 把 handle 切成父级链：src/foo/bar.ts → [src/foo, src, .]；src/foo → [src, .]。 */
export function parentChain(handle: string): string[] {
	const parts = handle.split("/").filter((p) => p && p !== ".");
	if (parts.length === 0) {
		return [];
	}
	const chain: string[] = [];
	for (let i = parts.length - 1; i > 0; i -= 1) {
		chain.push(parts.slice(0, i).join("/"));
	}
	chain.push(".");
	return chain;
}

/** 按时间有序回放事件，计算 DOI。事件 time 相等时保持输入顺序（因果序）。 */
export function computeDoi(
	events: InteractionEvent[],
	now: number,
	config: DoiConfig = DEFAULT_DOI_CONFIG,
): DoiResult {
	const states = new Map<string, HandleState>();
	// 上下文年龄从事件流首条时间算起
	const contextStart = events.length > 0 ? Date.parse(events[0]!.time) : now;

	function decayTo(state: HandleState, at: number, scale: number): void {
		const elapsedHours = Math.max(0, at - state.lastTouch) / MS_PER_HOUR;
		state.score -= config.decayPerHour * scale * elapsedHours;
	}

	/** 触碰一个 handle（含父级链传播），权重按生命周期份额逐级指数衰减。 */
	function touch(
		handle: string,
		contentType: ContentType,
		weight: number,
		at: number,
	): void {
		const age = Math.max(0, at - contextStart);
		const { scale, share } = lifecycleAt(age, config);

		// 自身：衰减重置——负值归零再加权重，一碰即正
		let state = states.get(handle);
		if (state) {
			decayTo(state, at, scale);
			state.score = Math.max(state.score, 0) + weight;
			state.lastTouch = at;
			state.touches += 1;
			state.contentType = contentType;
		} else {
			state = { score: weight, lastTouch: at, touches: 1, contentType };
			states.set(handle, state);
		}

		// 父级链：× share^depth（指数衰减传播）
		let w = weight;
		for (const parent of parentChain(handle)) {
			w *= share;
			if (w < 1e-9) {
				break;
			}
			const ps = states.get(parent);
			if (ps) {
				decayTo(ps, at, scale);
				ps.score = Math.max(ps.score, 0) + w;
				ps.lastTouch = at;
				ps.touches += 1;
			} else {
				states.set(parent, {
					score: w,
					lastTouch: at,
					touches: 1,
					contentType: "directory",
				});
			}
		}
	}

	for (const ev of events) {
		const at = Date.parse(ev.time);
		if (!Number.isFinite(at)) {
			continue;
		}
		touch(ev.handle, ev.contentType, config.weight[ev.kind] ?? 0, at);
	}

	// 收尾：把每个 handle 衰减到 now，并按阈值分类
	const scores = new Map<string, DoiScore>();
	for (const [handle, state] of states) {
		// 用 now 对应的生命周期参数做最终衰减
		const finalAge = Math.max(0, now - contextStart);
		const { scale } = lifecycleAt(finalAge, config);
		decayTo(state, now, scale);
		scores.set(handle, {
			handle,
			contentType: state.contentType,
			doi: state.score,
			landmark: state.score > config.landmarkFloor,
			visible: state.score > config.visibleFloor,
			lastTouchAt: state.lastTouch,
			touchCount: state.touches,
		});
	}

	const byDoi = (a: string, b: string) =>
		(scores.get(b)?.doi ?? 0) - (scores.get(a)?.doi ?? 0);
	const landmarks = [...scores.entries()]
		.filter(([, s]) => s.landmark)
		.map(([h]) => h)
		.sort(byDoi);
	const visible = [...scores.entries()]
		.filter(([, s]) => s.visible)
		.map(([h]) => h)
		.sort(byDoi);

	return { scores, landmarks, visible };
}
