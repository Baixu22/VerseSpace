/**
 * 地标投影测试（TF-0089）：过滤 / 排序 / 装饰 / 折叠四种只读投影，
 * 验收——地标列表可直接作为『这次干了什么』的答案。
 */

import { describe, expect, test } from "bun:test";
import { computeDoi } from "./doi";
import { projectLandmarks } from "./project";
import type { InteractionEvent } from "./types";

const T0 = Date.parse("2026-08-31T10:00:00.000Z");

function ev(
	handle: string,
	kind: InteractionEvent["kind"],
	offsetMinutes: number,
	delta = 1,
	origin = "ws-a",
): InteractionEvent {
	return {
		time: new Date(T0 + offsetMinutes * 60_000).toISOString(),
		kind,
		origin,
		contentType: "file",
		handle,
		delta,
	};
}

/** 造一个 2 小时活跃任务：8 核心文件反复触碰，20 外围文件偶发。 */
function activeTaskEvents(): InteractionEvent[] {
	const events: InteractionEvent[] = [];
	const core = Array.from({ length: 8 }, (_, i) => `src/core/c${i}.ts`);
	const periphery = Array.from({ length: 20 }, (_, i) => `src/peri/p${i}.ts`);
	for (let min = 0; min < 120; min += 10) {
		for (const path of core) {
			events.push(
				ev(
					path,
					min % 20 === 0 ? "edit" : "selection",
					min,
					min % 20 === 0 ? 12 : 1,
				),
			);
		}
		if (min % 30 === 0) {
			events.push(
				ev(periphery[(min / 30) % periphery.length]!, "selection", min),
			);
		}
	}
	return events;
}

describe("过滤投影", () => {
	test("只投影地标；目录地标与文件地标共存", () => {
		const result = computeDoi(activeTaskEvents(), T0 + 120 * 60_000);
		const projected = projectLandmarks(result, activeTaskEvents());
		// 顶层全部来自地标池，且按 DOI 降序
		expect(projected.length).toBeGreaterThan(0);
		for (const lm of projected) {
			expect(result.scores.get(lm.handle)?.landmark).toBe(true);
		}
		// 目录聚合后顶层信息密度更高（目录地标 + 项目根）
		expect(projected.map((lm) => lm.handle)).toContain("src/core");
	});

	test("地标为空时回退到可见集 top-N（列表永不为空）", () => {
		const events = [ev("src/a.ts", "selection", 0)];
		const result = computeDoi(events, T0 + 60_000);
		const projected = projectLandmarks(result, events);
		expect(projected.length).toBeGreaterThan(0);
		expect(projected.length).toBeLessThanOrEqual(8);
	});

	test("完全无事件时返回空列表", () => {
		const result = computeDoi([], T0);
		expect(projectLandmarks(result, [])).toHaveLength(0);
	});
});

describe("排序投影", () => {
	test("DOI 降序，同分按最近触碰", () => {
		const result = computeDoi(activeTaskEvents(), T0 + 120 * 60_000);
		const projected = projectLandmarks(result, activeTaskEvents());
		for (let i = 1; i < projected.length; i += 1) {
			expect(projected[i]!.doi).toBeLessThanOrEqual(projected[i - 1]!.doi);
		}
	});
});

describe("装饰投影", () => {
	test("统计编辑/触碰次数、累计 delta、来源写者、最近触碰", () => {
		const events = [
			ev("src/hot.ts", "edit", 0, 5, "ws-a"),
			ev("src/hot.ts", "edit", 10, 3, "ws-a"),
			ev("src/hot.ts", "selection", 20, 1, "human"),
		];
		const result = computeDoi(events, T0 + 30 * 60_000);
		const projected = projectLandmarks(result, events);
		const hot = projected.find((lm) => lm.handle === "src/hot.ts");
		expect(hot).toBeDefined();
		expect(hot?.editCount).toBe(2);
		expect(hot?.selectionCount).toBe(1);
		expect(hot?.deltaTotal).toBe(9);
		expect(hot?.origins).toEqual(["ws-a", "human"]);
		expect(hot?.lastTouchAt).toBe(events[2]!.time);
	});
});

describe("折叠投影", () => {
	test("文件地标折叠进直接父目录地标（8 文件全聚合）", () => {
		const result = computeDoi(activeTaskEvents(), T0 + 120 * 60_000);
		const projected = projectLandmarks(result, activeTaskEvents());
		const coreDir = projected.find((lm) => lm.handle === "src/core");
		expect(coreDir).toBeDefined();
		expect(coreDir?.collapsed.length).toBe(8);
		// 折叠后文件不再出现在顶层列表
		for (const lm of projected) {
			expect(lm.handle).not.toMatch(/^src\/core\/c\d+\.ts$/);
		}
	});

	test("回退池中父目录不是地标时不折叠（保留文件条目）", () => {
		const events = [ev("src/hot.ts", "edit", 0), ev("src/hot.ts", "edit", 10)];
		const result = computeDoi(events, T0 + 20 * 60_000);
		const projected = projectLandmarks(result, events);
		// src 目录非地标（DOI 不足），src/hot.ts 保留在顶层
		expect(projected.map((lm) => lm.handle)).toContain("src/hot.ts");
	});
});

describe("验收：地标列表可作为『这次干了什么』的答案", () => {
	test("summary 一句话可读，含编辑/触碰/改动/时间", () => {
		const result = computeDoi(activeTaskEvents(), T0 + 120 * 60_000);
		const projected = projectLandmarks(result, activeTaskEvents());
		for (const lm of projected) {
			expect(lm.summary.length).toBeGreaterThan(4);
			expect(lm.summary).toMatch(/最后 \d{2}:\d{2}/);
		}
		const coreDir = projected.find((lm) => lm.handle === "src/core")!;
		// 折叠子条目带 DOI 与说明
		expect(coreDir.collapsed[0]).toContain("DOI");
	});

	test("投影不修改输入（纯函数，不触发任何自动动作）", () => {
		const events = activeTaskEvents();
		const snapshot = JSON.stringify(events);
		const result = computeDoi(events, T0 + 120 * 60_000);
		projectLandmarks(result, events);
		expect(JSON.stringify(events)).toBe(snapshot);
	});
});
