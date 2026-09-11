/**
 * Mylyn DOI 测试（TF-0088）：
 *  - 衰减重置：负值一碰即正（验收 1）
 *  - 双阈值：>0 可见、>10 地标、≤0 过滤
 *  - 父级指数衰减传播（文件 → 目录 → 项目）
 *  - 生命周期自适应：年轻慢衰减宽搜索、成熟快衰减窄搜索
 *  - 地标集合规模稳定在约 5-15 个（验收 2）
 */

import { describe, expect, test } from "bun:test";
import { computeDoi, DEFAULT_DOI_CONFIG, parentChain } from "./doi";
import type { InteractionEvent } from "./types";

const T0 = Date.parse("2026-08-31T10:00:00.000Z");

function ev(
	handle: string,
	kind: InteractionEvent["kind"],
	offsetMinutes: number,
	origin = "ws-a",
): InteractionEvent {
	return {
		time: new Date(T0 + offsetMinutes * 60_000).toISOString(),
		kind,
		origin,
		contentType: kind === "edit" ? "file" : "file",
		handle,
		delta: 1,
	};
}

function doiOf(
	events: InteractionEvent[],
	nowMinutes: number,
	config = DEFAULT_DOI_CONFIG,
) {
	return computeDoi(events, T0 + nowMinutes * 60_000, config);
}

describe("衰减重置规则", () => {
	test("衰减到负的元素一碰就立刻转正（验收 1）", () => {
		const config = { ...DEFAULT_DOI_CONFIG, decayPerHour: 10 }; // 剧烈衰减
		const events = [
			ev("src/a.ts", "selection", 0),
			ev("src/a.ts", "selection", 60), // 10 小时后：0+1 → 1 - 10×1 = -9
		];
		const result = doiOf(events, 60, config);
		// 触碰后立即为正（-9 归零 + 1）
		expect(result.scores.get("src/a.ts")?.doi ?? -99).toBeGreaterThan(0);
		expect(result.scores.get("src/a.ts")?.visible).toBe(true);
	});

	test("长时间不碰的元素衰减到负并被过滤", () => {
		const events = [ev("src/stale.ts", "selection", 0)];
		// 30 分钟：年轻端慢衰减（scale=0.5），1 - 0.1×0.5×0.5 ≈ 0.98 > 0
		const recent = doiOf(events, 30);
		expect(recent.scores.get("src/stale.ts")?.visible).toBe(true);
		// 20 小时：成熟端快衰减（scale=2），1 - 0.1×2×20 = -3 → 过滤
		const stale = doiOf(events, 60 * 20);
		expect(stale.scores.get("src/stale.ts")?.visible).toBe(false);
		expect(stale.visible).not.toContain("src/stale.ts");
	});
});

describe("阈值分类", () => {
	test("DOI>0 可见，DOI>10 地标，≤0 过滤", () => {
		const events = [
			// 频繁触碰 src/hot.ts：每次 edit +2，12 次 → 高 DOI
			...Array.from({ length: 12 }, (_, i) => ev("src/hot.ts", "edit", i * 5)),
			// 单次触碰 src/warm.ts：低 DOI
			ev("src/warm.ts", "selection", 0),
		];
		const result = doiOf(events, 60);
		const hot = result.scores.get("src/hot.ts")!;
		const warm = result.scores.get("src/warm.ts")!;
		expect(hot.landmark).toBe(true);
		expect(hot.visible).toBe(true);
		expect(warm.landmark).toBe(false);
		expect(warm.visible).toBe(true);
		expect(result.landmarks).toContain("src/hot.ts");
		expect(result.visible).toContain("src/warm.ts");
	});

	test("地标按 DOI 降序排列", () => {
		const events = [
			...Array.from({ length: 12 }, (_, i) => ev("src/a.ts", "edit", i * 5)),
			...Array.from({ length: 6 }, (_, i) => ev("src/b.ts", "edit", i * 5)),
		];
		const result = doiOf(events, 60);
		expect(result.landmarks[0]).toBe("src/a.ts");
	});
});

describe("父级指数衰减传播", () => {
	test("文件兴趣向目录与项目根传播，逐级衰减", () => {
		const result = doiOf([ev("src/foo/bar.ts", "edit", 0)], 0);
		const file = result.scores.get("src/foo/bar.ts")?.doi ?? 0;
		const dir = result.scores.get("src/foo")?.doi ?? 0;
		const root = result.scores.get(".")?.doi ?? 0;
		// edit=2；年轻端 parentShare=0.7 → dir=2×0.7=1.4，root=2×0.7²=0.98
		expect(dir).toBeGreaterThan(root);
		expect(dir).toBeLessThan(file);
		expect(root).toBeLessThan(dir);
	});

	test("parentChain 生成逐级父链", () => {
		expect(parentChain("src/foo/bar.ts")).toEqual(["src/foo", "src", "."]);
		expect(parentChain("src/foo")).toEqual(["src", "."]);
		expect(parentChain(".")).toEqual([]);
	});
});

describe("生命周期自适应常数", () => {
	test("成熟上下文衰减更快（同样久未触碰，残留更少）", () => {
		// 上下文 A：从 0 开始，到 120 分钟成熟；B 从 0 到 30 分钟年轻
		// 两个上下文各自在 0 分钟触碰一次文件，之后都不再碰
		const youngResult = doiOf([ev("src/x.ts", "selection", 0)], 30);
		// 用同样事件但把 now 放到成熟端：配置里 matureAgeMs=60min
		const oldConfig = {
			...DEFAULT_DOI_CONFIG,
			youngAgeMs: 0,
			matureAgeMs: 60 * 60_000,
		};
		const matureResult = doiOf(
			[ev("src/x.ts", "selection", 0)],
			120,
			oldConfig,
		);
		// 年轻端衰减 scale=0.5：30min → 1 - 0.1×0.5×0.5 = 0.975
		// 成熟端衰减 scale=2：120min → 1 - 0.1×2×2 = 0.6
		expect(youngResult.scores.get("src/x.ts")?.doi ?? 0).toBeGreaterThan(
			matureResult.scores.get("src/x.ts")?.doi ?? 99,
		);
	});

	test("年轻端宽传播（parentShare 高），成熟端窄传播（低）", () => {
		const young = doiOf([ev("src/foo/bar.ts", "edit", 0)], 0);
		const oldConfig = {
			...DEFAULT_DOI_CONFIG,
			youngAgeMs: 0,
			matureAgeMs: 60 * 60_000,
		};
		const mature = doiOf([ev("src/foo/bar.ts", "edit", 0)], 120, oldConfig);
		const youngDir = young.scores.get("src/foo")?.doi ?? 0;
		const matureDir = mature.scores.get("src/foo")?.doi ?? 0;
		// 年轻 share=0.7，成熟 share=0.3；成熟目录兴趣显著更低
		expect(matureDir).toBeLessThan(youngDir);
	});
});

describe("地标集合规模（验收 2）", () => {
	test("活跃任务中地标数量稳定在约 5-15 个", () => {
		// 模拟 2 小时任务：8 个核心文件反复触碰，20 个外围文件偶发触碰
		const events: InteractionEvent[] = [];
		const core = Array.from({ length: 8 }, (_, i) => `src/core/c${i}.ts`);
		const periphery = Array.from({ length: 20 }, (_, i) => `src/peri/p${i}.ts`);
		for (let min = 0; min < 120; min += 10) {
			for (const path of core) {
				events.push(ev(path, min % 20 === 0 ? "edit" : "selection", min));
			}
			if (min % 30 === 0) {
				events.push(
					ev(periphery[(min / 30) % periphery.length]!, "selection", min),
				);
			}
		}
		const result = doiOf(events, 120);
		expect(result.landmarks.length).toBeGreaterThanOrEqual(5);
		expect(result.landmarks.length).toBeLessThanOrEqual(15);
	});
});

/**
 * TF-0161 候选 B：递减收益上限（**默认不设**，行为与出厂逐字一致）。
 *
 * 实测背景（2026-09-12，四个真实现场）：租户那 3 条地标靠同一 handle 上 25 次
 * 同种手势越线，7 开启上限后清成 0 条；但对**相对选择**（每会话 top-K）逐字无
 * 影响（89 会话 / 10 文件不变）——那些会话只碰过一个文件，所以这不是权重问题。
 * 因此该参数只作诊断与候选，默认关闭。
 */
describe("TF-0161 递减收益上限（默认关闭）", () => {
	const repeatEvents: InteractionEvent[] = Array.from(
		{ length: 25 },
		(_, index) => ({
			time: new Date(T0 + index * 1_000).toISOString(),
			kind: "edit" as const,
			handle: "src/heartbeat.ts",
			contentType: "file" as const,
			origin: "ws-a",
			delta: 1,
		}),
	);
	const diverseEvents: InteractionEvent[] = [
		...[0, 1, 2].map((index) => ({
			time: new Date(T0 + index * 1_000).toISOString(),
			kind: "edit" as const,
			handle: "src/real.ts",
			contentType: "file" as const,
			origin: "ws-a",
			delta: 1,
		})),
		...[0, 1, 2].map((index) => ({
			time: new Date(T0 + 60_000 + index * 1_000).toISOString(),
			kind: "selection" as const,
			handle: "src/real.ts",
			contentType: "file" as const,
			origin: "ws-a",
			delta: 1,
		})),
	];
	const withCap = {
		...DEFAULT_DOI_CONFIG,
		repeatCap: { free: 3, after: 0.1 },
	};
	const doiOf = (events: InteractionEvent[], config = DEFAULT_DOI_CONFIG) =>
		computeDoi(events, T0 + 120_000, config).scores;

	test("默认不设上限：读数与出厂行为完全一致", () => {
		expect(doiOf(repeatEvents).get("src/heartbeat.ts")?.doi).toBe(
			computeDoi(repeatEvents, T0 + 120_000).scores.get("src/heartbeat.ts")
				?.doi,
		);
		expect(doiOf(repeatEvents).get("src/heartbeat.ts")?.landmark).toBe(true);
	});

	test("开了上限：纯重复被显著折减，多样性会话不受影响", () => {
		const repeatedOn = doiOf(repeatEvents, withCap).get("src/heartbeat.ts")!;
		const repeatedOff = doiOf(repeatEvents).get("src/heartbeat.ts")!;
		expect(repeatedOn.doi).toBeLessThan(repeatedOff.doi * 0.5);
		// 每种手势都没超过 free 的会话：带上限与不带逐字相同（不误杀真信号）
		expect(doiOf(diverseEvents, withCap).get("src/real.ts")?.doi).toBe(
			doiOf(diverseEvents).get("src/real.ts")?.doi,
		);
	});
});
