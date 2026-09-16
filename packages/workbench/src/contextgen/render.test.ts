import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Goal } from "../types/goal";
import type { Workspot } from "../types/workspot";
import type { ContextInput } from "./render";
import { DEFAULT_EVENT_LINE_CHARS, renderContext } from "./render";

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
	version: 0,
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
		expect(markdown.replaceAll("\\", "/")).toMatchSnapshot();
	});

	// The snapshot above is POSIX-normalised on purpose. The interface path in
	// the rendered context comes from `join(projectRoot, canonicalPath)`, so it
	// carries the host separator — a snapshot of the raw markdown therefore only
	// matches on the platform that recorded it (the Windows-authored snapshot
	// failed on the macOS CI runner, 2026-09-11). Keep the platform-neutral
	// snapshot AND assert the host-correct path here, so neither coverage is
	// lost.
	test("interface absolute path uses the host path separator", () => {
		const markdown = renderContext({
			...baseInput(),
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
		});
		expect(markdown).toContain(
			`文件路径: ${join("/proj", "contracts/api.md")}`,
		);
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

	test("does not leak thread lifecycle events into agent context", () => {
		const markdown = renderContext({
			...baseInput(),
			events: [
				{
					timestamp: "2026-08-28T01:00:00.000Z",
					source: "threads",
					type: "thread.left",
					payload: { threadId: "t-1", messageCount: 4 },
				},
				{
					timestamp: "2026-08-28T01:01:00.000Z",
					source: "runtime",
					type: "checkpoint_moved",
					payload: { summary: "cp-1 verified" },
				},
			],
		});
		expect(markdown).toContain("checkpoint_moved: cp-1 verified");
		expect(markdown).not.toContain("thread.left");
		expect(markdown).not.toContain("messageCount");
	});

	test("a 1MB payload stays bounded to the per-event line budget (TF-0145)", () => {
		const marker = "P".repeat(1024 * 1024);
		const markdown = renderContext({
			...baseInput(),
			events: [
				{
					timestamp: "2026-08-28T01:00:00.000Z",
					source: "runtime",
					type: "checkpoint_moved",
					payload: { blob: marker }, // no summary → JSON.stringify fallback
				},
			],
		});
		for (const line of markdown
			.split("\n")
			.filter((l) => l.startsWith("- ["))) {
			expect(line.length).toBeLessThanOrEqual(DEFAULT_EVENT_LINE_CHARS);
		}
		expect(markdown).not.toContain(marker);
		// the tail is an explicit ellipsis, not silent corruption
		expect(markdown).toContain("…");
	});

	test("a long summary string is capped by the same budget", () => {
		const markdown = renderContext({
			...baseInput(),
			events: [
				{
					timestamp: "2026-08-28T01:00:00.000Z",
					source: "runtime",
					type: "checkpoint_moved",
					payload: { summary: "S".repeat(50_000) },
				},
			],
		});
		const eventLine = markdown
			.split("\n")
			.find((line) => line.startsWith("- ["))!;
		expect(eventLine.length).toBe(DEFAULT_EVENT_LINE_CHARS);
		expect(eventLine.endsWith("…")).toBe(true);
	});

	test("eventLineChars is configurable per render", () => {
		const markdown = renderContext({
			...baseInput(),
			eventLineChars: 60,
			events: [
				{
					timestamp: "2026-08-28T01:00:00.000Z",
					source: "runtime",
					type: "checkpoint_moved",
					payload: { summary: "L".repeat(5000) },
				},
			],
		});
		const eventLine = markdown
			.split("\n")
			.find((line) => line.startsWith("- ["))!;
		expect(eventLine.length).toBe(60);
		expect(eventLine.endsWith("…")).toBe(true);
	});
});
