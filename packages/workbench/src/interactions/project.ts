/**
 * 地标投影（TF-0089）— 在 DOI 结果之上做四种只读投影：
 *  过滤 → 排序 → 装饰 → 折叠。
 *
 * 设计约束（TF-0089 requirements / TF-0057 核心判据）：
 *  - 只做投影，绝不基于 DOI 触发任何自动动作（只呈现，不指挥）；
 *  - 输出是『这次干了什么』的直接答案：谁在何时对什么动了多少。
 *
 * 过滤：只保留地标；地标为空时回退到可见集 top-N（列表永不为空）。
 * 排序：DOI 降序（DOI 已内含时间衰减），同分按最近触碰。
 * 装饰：统计每个 handle 的编辑/触碰次数、累计 delta、最近触碰、来源写者。
 * 折叠：文件地标若其直接父目录也是地标，折叠进父目录（父条目标注内部条目数）。
 */

import type { DoiResult } from "./doi";
import type { ContentType, InteractionEvent } from "./types";

/** 地标为空时的可见回退上限。 */
const FALLBACK_VISIBLE = 8;

export interface ProjectedLandmark {
	handle: string;
	contentType: ContentType;
	doi: number;
	/** 装饰统计：编辑 / 触碰次数、累计改动量、最近触碰、来源写者。 */
	editCount: number;
	selectionCount: number;
	deltaTotal: number;
	lastTouchAt: string;
	origins: string[];
	/** 折叠进来的直接子条目 handle（按 DOI 降序）。 */
	collapsed: string[];
	/** 一句话描述：直接回答『这次干了什么』。 */
	summary: string;
}

interface EventStats {
	editCount: number;
	selectionCount: number;
	deltaTotal: number;
	lastTouchAt: string;
	origins: Set<string>;
}

/** 对交互事件流做单遍统计，供装饰用。 */
function collectStats(events: InteractionEvent[]): Map<string, EventStats> {
	const stats = new Map<string, EventStats>();
	for (const ev of events) {
		if (ev.kind === "interest-reduced") continue;
		let s = stats.get(ev.handle);
		if (!s) {
			s = {
				editCount: 0,
				selectionCount: 0,
				deltaTotal: 0,
				lastTouchAt: ev.time,
				origins: new Set(),
			};
			stats.set(ev.handle, s);
		}
		if (ev.kind === "edit") {
			s.editCount += 1;
		} else if (ev.kind === "selection") {
			s.selectionCount += 1;
		}
		s.deltaTotal += Math.max(0, ev.delta);
		s.origins.add(ev.origin);
		if (Date.parse(ev.time) > Date.parse(s.lastTouchAt)) {
			s.lastTouchAt = ev.time;
		}
	}
	return stats;
}

function shortTime(iso: string): string {
	const d = new Date(iso);
	if (!Number.isFinite(d.getTime())) {
		return iso;
	}
	return d.toTimeString().slice(0, 5);
}

/** 装饰一条地标为『这次干了什么』的一句话。 */
function summarize(lm: Omit<ProjectedLandmark, "summary">): string {
	const bits: string[] = [];
	if (lm.editCount > 0) {
		bits.push(`编辑 ${lm.editCount} 次`);
	}
	if (lm.selectionCount > 0) {
		bits.push(`触碰 ${lm.selectionCount} 次`);
	}
	if (lm.deltaTotal > 0) {
		bits.push(`改动 ${lm.deltaTotal} 行`);
	}
	bits.push(`最后 ${shortTime(lm.lastTouchAt)}`);
	return bits.join(" · ");
}

/**
 * 四种投影一次完成：过滤 + 折叠（父子合并）→ 排序 → 装饰。
 * 纯函数，无副作用。
 */
export function projectLandmarks(
	result: DoiResult,
	events: InteractionEvent[],
): ProjectedLandmark[] {
	const stats = collectStats(events);

	// 1. 过滤：地标优先，空则回退可见集 top-N
	const pool =
		result.landmarks.length > 0
			? result.landmarks
			: result.visible.slice(0, FALLBACK_VISIBLE);
	if (pool.length === 0) {
		return [];
	}

	// 2. 折叠：文件地标若直接父目录是『地标』，折进父目录。
	//    回退池（无地标时）里的可见目录不是地标，不能作折叠目标。
	const poolSet = new Set(pool);
	const top: string[] = [];
	const folded = new Map<string, string[]>();
	for (const handle of pool) {
		const score = result.scores.get(handle);
		if (score?.contentType !== "file") {
			top.push(handle);
			continue;
		}
		const parent = directParent(handle);
		if (parent && poolSet.has(parent) && result.scores.get(parent)?.landmark) {
			const list = folded.get(parent) ?? [];
			list.push(handle);
			folded.set(parent, list);
		} else {
			top.push(handle);
		}
	}

	// 3. 排序：DOI 降序，同分按最近触碰
	const byDoiThenTouch = (a: string, b: string): number => {
		const sa = result.scores.get(a);
		const sb = result.scores.get(b);
		const diff = (sb?.doi ?? 0) - (sa?.doi ?? 0);
		if (diff !== 0) {
			return diff;
		}
		return (sb?.lastTouchAt ?? 0) - (sa?.lastTouchAt ?? 0);
	};
	top.sort(byDoiThenTouch);
	for (const children of folded.values()) {
		children.sort(byDoiThenTouch);
	}

	// 4. 装饰
	return top.map((handle) => {
		const score = result.scores.get(handle)!;
		const st = stats.get(handle);
		const collapsed = (folded.get(handle) ?? []).map((h) => {
			const c = result.scores.get(h);
			const cs = stats.get(h);
			const sub: Omit<ProjectedLandmark, "summary"> = {
				handle: h,
				contentType: c?.contentType ?? "file",
				doi: c?.doi ?? 0,
				editCount: cs?.editCount ?? 0,
				selectionCount: cs?.selectionCount ?? 0,
				deltaTotal: cs?.deltaTotal ?? 0,
				lastTouchAt: cs?.lastTouchAt ?? "",
				origins: cs ? [...cs.origins] : [],
				collapsed: [],
			};
			return `${h}（DOI ${sub.doi.toFixed(1)}，${summarize(sub)}）`;
		});
		const lm: Omit<ProjectedLandmark, "summary"> = {
			handle,
			contentType: score.contentType,
			doi: score.doi,
			editCount: st?.editCount ?? 0,
			selectionCount: st?.selectionCount ?? 0,
			deltaTotal: st?.deltaTotal ?? 0,
			lastTouchAt: st?.lastTouchAt ?? new Date(score.lastTouchAt).toISOString(),
			origins: st ? [...st.origins] : [],
			collapsed,
		};
		return { ...lm, summary: summarize(lm) };
	});
}

/** 直接父目录：src/foo/bar.ts → src/foo；无父级返回 null。 */
function directParent(handle: string): string | null {
	const parts = handle.split("/").filter((p) => p && p !== ".");
	if (parts.length <= 1) {
		return null;
	}
	return parts.slice(0, -1).join("/");
}
