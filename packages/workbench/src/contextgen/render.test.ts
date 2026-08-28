import { describe, expect, test } from "bun:test";
import type { Goal } from "../types/goal";
import type { Workspot } from "../types/workspot";
import type { ContextInput } from "./render";
import { renderContext } from "./render";

const workspot: Workspot = {
	id: "ws-a",
	branch: "ws/ws-a",
	worktreePath: "../ws-a",
	primaryTask: "g-1",
	binding: "primary",
	status: "active",
	contextNeeds: { decisions: [], interfaces: [] },
};

const goal: Goal = {
	id: "g-1",
	title: "实现 Blackboard 数据层",
	status: "in_progress",
	acceptance: [
		{
			assertion: "goals 读写往返一致",
			verification: { strategy: "test", command: "bun test" },
		},
		{ assertion: "原子写不留临时文件" },
	],
	dependsOn: [],
	checkpoints: [],
	verifiedAgainst: { interfaces: {}, decisions: [] },
};

function baseInput(): ContextInput {
	return {
		workspot,
		goal,
		decisions: [],
		interfaces: [],
		projectRoot: "/proj",
		events: [],
		conflicts: [],
	};
}

describe("renderContext", () => {
	test("full context renders every section (snapshot)", () => {
		const markdown = renderContext({
			...baseInput(),
			decisions: [
				{
					id: "d-1",
					title: "原子写",
					rationale: "防止半截 YAML",
					timestamp: "2026-08-28T00:00:00.000Z",
					author: "human",
				},
			],
			interfaces: [
				{
					key: "core/api",
					canonicalPath: "contracts/api.md",
					version: 3,
					publishedBy: "ws-b",
					lastModified: "2026-08-28T00:00:00.000Z",
					contentHash: "abc",
					subscribers: [],
				},
			],
			events: [
				{
					timestamp: "2026-08-28T01:00:00.000Z",
					source: "runtime",
					type: "checkpoint_moved",
					payload: { summary: "cp-1 staging → verified" },
				},
			],
			conflicts: [
				{
					id: "c-1",
					kind: "workspot_status",
					detail: "ws-a active 但任务已取消",
					createdAt: "2026-08-28T02:00:00.000Z",
				},
			],
		});
		expect(markdown).toMatchSnapshot();
	});

	test("empty optional sections are omitted", () => {
		const markdown = renderContext(baseInput());
		expect(markdown).toContain("## 你的任务");
		expect(markdown).toContain("实现 Blackboard 数据层");
		expect(markdown).toContain("## 验收条件");
		expect(markdown).not.toContain("## 必须遵守的架构决策");
		expect(markdown).not.toContain("## 可用的接口定义");
		expect(markdown).not.toContain("## 最近的相关事件");
		expect(markdown).not.toContain("## 当前已知冲突");
		expect(markdown).toContain("## 约束");
	});

	test("acceptance lines carry their verification strategy", () => {
		const markdown = renderContext(baseInput());
		expect(markdown).toContain("goals 读写往返一致〔验证：test〕");
		expect(markdown).toContain("- 原子写不留临时文件\n");
	});
});
