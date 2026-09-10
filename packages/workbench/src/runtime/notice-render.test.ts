import { expect, test } from "bun:test";
import { renderNotice } from "./notice-render";

test("低预算下事实整行保留，省略文件数量与实际展示一致", () => {
	const claims = Array.from({ length: 12 }, (_, index) => ({
		path: `src/file-${index}.ts`,
		observedVersion: "a".repeat(64),
		currentVersion: "b".repeat(64),
		diff: "- old\n+ new\n".repeat(100),
	}));
	for (const budget of [32, 64, 120, 300]) {
		const output = renderNotice(claims, budget);
		expect(output.length).toBeLessThanOrEqual(budget * 4);
		const displayed = [...output.matchAll(/^- (src\/file-\d+\.ts)$/gm)];
		for (const match of displayed) {
			expect(output).toContain(
				`- ${match[1]}\n  观察版本 ${"a".repeat(64)} → 当前版本 ${"b".repeat(64)}`,
			);
		}
		const omitted = Number(output.match(/（(\d+) 个文件未展开/)?.[1] ?? 0);
		expect(displayed.length + omitted).toBe(claims.length);
	}
});

test("长 diff 允许部分展示，保留截断说明和闭合代码块", () => {
	const output = renderNotice(
		[
			{
				path: "a.ts",
				observedVersion: "old",
				currentVersion: "new",
				diff: "- old\n+ new\n".repeat(100),
			},
		],
		100,
	);
	expect(output).toContain("```diff\n- old\n+ new");
	expect(output).toContain("…（diff 已截断）\n```");
	expect(output).toContain("1 条 diff 因通知预算未完整展开");
	expect(output.length).toBeLessThanOrEqual(400);
});

test("极小预算要么保留总数，要么不发送不完整通知", () => {
	const claims = [
		{ path: "a.ts", observedVersion: "old", currentVersion: "new" },
	];
	expect(renderNotice(claims, 0)).toBe("");
	expect(renderNotice(claims, 1)).toBe("");
	expect(renderNotice([], 300)).toBe("");
	for (const budget of [4, 8, 16]) {
		const output = renderNotice(claims, budget);
		expect(output).toContain("1 个文件");
		expect(output.length).toBeLessThanOrEqual(budget * 4);
	}
});
