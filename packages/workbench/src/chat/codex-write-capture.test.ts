import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { replayCodexFixture } from "../test/codex-fixture-replay";
import { approvalTargets } from "./codex-app-server/approval-targets";
import { decideServerRequest } from "./codex-app-server/protocol";
import { extractCodexFootprint } from "./codex-footprint";
import {
	createCodexRenderState,
	reduceCodexRenderEvent,
} from "./codex-render-state";

/**
 * codex 写侧门禁（issue #31）。
 *
 * ADR-0017 §「本轮实现边界」把写侧记为「尚无证据」：11 个保留夹具只有
 * `read` / `listFiles`，`WRITE_ACTIONS`（edit / write / applyPatch / createFile）
 * 与 `fileChange` / `fileRead` item 类型都没有样本。
 *
 * 2026-09-27 用真实 codex `0.158.0-alpha.2.1` + 本地网关（模型 `glm-5.3-flash`、
 * read-only 沙箱、审批 on-request）抓到一个真实写回合：提示词要求模型用
 * `apply_patch` 把 `src/target.ts` 的 `target = 1` 改成 `2`。文件确实被改动
 * （夹具里有改动后读回的 `export const target = 2;`），但整条流里**没有**任何
 * 原生写 item，审批的 `commandActions` 也全部是 `type: "unknown"` 且没有 `path`。
 *
 * 本文件把这个读数钉住：写侧门禁不是「夹具还没收集到」，而是在这条车道上
 * **结构性缺席**。它只覆盖一次抓取（一个模型、一个 profile、一个回合）；
 * ADR-0023「对某个命令的负面观测不能泛化到整个 CLI 版本」同样适用于此——
 * 见 docs/handoff/2026-09-27-codex-write-capture.md。
 */
const FIXTURES = join(import.meta.dir, "fixtures");
const WRITE_TURN = join(FIXTURES, "streams/codex/write-turn-0.158.jsonl");
const WRITE_APPROVALS = join(FIXTURES, "approvals/apply-patch-0.158.json");

/** 原生写 item 类型：本门禁要钉住真实写回合里一个都没有。 */
const NATIVE_WRITE_ITEM_TYPES = ["fileChange", "applyPatch", "fileRead"];
/** `codex-footprint.ts` 的 WRITE_ACTIONS：commandAction 侧的写类型。 */
const WRITE_ACTION_TYPES = ["edit", "write", "applyPatch", "createFile"];
/** `codex-footprint.ts` 的 READ_ACTIONS：唯一被结构化归因的一侧。 */
const READ_ACTION_TYPES = ["read", "listFiles"];

/** 真实 0.158 写回合里出现、而 render 决策表没有决策的 6 类形状。 */
const UNMODELED_REAL_SHAPES: Array<{
	readonly key: string;
	readonly event: Record<string, unknown>;
}> = [
	{
		key: "item/commandExecution/outputDelta",
		event: {
			type: "item/commandExecution/outputDelta",
			threadId: "01a0deb7-5fc2-7b80-9dc2-c8f09b5eb124",
			turnId: "01a0deb7-5ff0-7161-bba6-decda1e0da97",
			itemId: "call_d8118b5360ef4f889ae99552",
			delta: "export const target = 1;",
		},
	},
	{
		key: "item/reasoning/summaryPartAdded",
		event: {
			type: "item/reasoning/summaryPartAdded",
			threadId: "01a0deb7-5fc2-7b80-9dc2-c8f09b5eb124",
			turnId: "01a0deb7-5ff0-7161-bba6-decda1e0da97",
			itemId: "rs_1dda0e82cdd83c8a678482c874204baa",
			summaryIndex: 0,
		},
	},
	{
		key: "item/reasoning/summaryTextDelta",
		event: {
			type: "item/reasoning/summaryTextDelta",
			threadId: "01a0deb7-5fc2-7b80-9dc2-c8f09b5eb124",
			turnId: "01a0deb7-5ff0-7161-bba6-decda1e0da97",
			itemId: "rs_1dda0e82cdd83c8a678482c874204baa",
			delta: "We need comply edit using apply_patch, but sandbox read-only",
			summaryIndex: 0,
		},
	},
	{
		key: "serverRequest/resolved",
		event: {
			type: "serverRequest/resolved",
			threadId: "01a0deb7-5fc2-7b80-9dc2-c8f09b5eb124",
			requestId: 4,
		},
	},
	{
		key: "warning",
		event: {
			type: "warning",
			threadId: "01a0deb7-5fc2-7b80-9dc2-c8f09b5eb124",
			message:
				"Model metadata for `glm-5.3-flash` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.",
		},
	},
	{
		key: "remoteControl/status/changed",
		event: {
			type: "remoteControl/status/changed",
			status: "disabled",
			serverName: "LAPTOP-3LN94GP7",
			installationId: "dd5cf73e-8b86-4a71-8873-f661c44f05ea",
			environmentId: null,
		},
	},
];

interface ApprovalRequest {
	method: string;
	id: number;
	params: Record<string, unknown>;
}

async function readJsonl(path: string): Promise<Record<string, unknown>[]> {
	return (await readFile(path, "utf8"))
		.split(/\r?\n/)
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: {};
}

/** Every `item/started` | `item/completed` payload carried by the stream. */
function itemFrames(
	lines: Record<string, unknown>[],
): Array<{ event: string; item: Record<string, unknown> }> {
	return lines
		.filter(
			(line) => line.type === "item/started" || line.type === "item/completed",
		)
		.map((line) => ({ event: String(line.type), item: asRecord(line.item) }));
}

/** Every `commandActions[]` entry carried by a `commandExecution` item. */
function commandActions(
	frames: Array<{ item: Record<string, unknown> }>,
): Array<Record<string, unknown>> {
	return frames.flatMap(({ item }) =>
		Array.isArray(item.commandActions)
			? item.commandActions.map((action) => asRecord(action))
			: [],
	);
}

/**
 * One entry per distinct `commandExecution` id. Codex reports the same item on
 * `item/started` and `item/completed`, so counting frames would double every
 * command; the completed frame is preferred because it carries the result.
 */
function distinctCommandItems(
	frames: Array<{ event: string; item: Record<string, unknown> }>,
): Array<Record<string, unknown>> {
	const byId = new Map<string, Record<string, unknown>>();
	for (const { event, item } of frames) {
		if (item.type !== "commandExecution") continue;
		const id = String(item.id ?? "");
		if (event === "item/completed" || !byId.has(id)) byId.set(id, item);
	}
	return [...byId.values()];
}

describe("Codex write-turn capture (issue #31)", () => {
	test("a real write turn carries no native write item and no write commandAction", async () => {
		const lines = await readJsonl(WRITE_TURN);
		const frames = itemFrames(lines);

		// The fixture is fed through the same reducer the live router uses.
		const replay = replayCodexFixture("write-turn-0.158", lines);
		expect(replay.snapshot.undecidedKeys).toEqual([]);

		// Only the four shapes the render table models appear. If codex starts
		// emitting a native write item, this list grows and the finding below has
		// to be revisited rather than silently inherited.
		const itemTypes = [...new Set(frames.map(({ item }) => item.type))].sort();
		expect(itemTypes).toEqual([
			"agentMessage",
			"commandExecution",
			"reasoning",
			"userMessage",
		]);
		for (const type of NATIVE_WRITE_ITEM_TYPES) {
			expect(
				frames.filter(({ item }) => item.type === type),
				`${type} 现在出现了：写侧证据已变，ADR-0017 的收窄结论必须重做`,
			).toEqual([]);
		}

		// commandAction 侧同样一个写类型都没有；而且非读动作里没有任何 `path`。
		const actions = commandActions(frames);
		expect(actions.length).toBeGreaterThan(0);
		for (const type of WRITE_ACTION_TYPES) {
			expect(
				actions.filter((action) => action.type === type),
				`commandAction type=${type} 现在出现了：写侧归因可能已经成立`,
			).toEqual([]);
		}
		const nonReadActionsWithPath = actions.filter(
			(action) =>
				!READ_ACTION_TYPES.includes(String(action.type)) && "path" in action,
		);
		expect(nonReadActionsWithPath).toEqual([]);
		// 读侧仍然被结构化归因——所以上面的「零」不是因为整条通道坏了。
		expect(
			actions.some(
				(action) => action.type === "read" && typeof action.path === "string",
			),
		).toBe(true);
	});

	test("the write landed, yet the footprint channel attributes nothing to it", async () => {
		const lines = await readJsonl(WRITE_TURN);
		const frames = itemFrames(lines);

		// 真实回合里写是成功的：这一条 read 的输出是改动后的内容。
		const readBacks = frames
			.filter(
				({ event, item }) =>
					event === "item/completed" && item.type === "commandExecution",
			)
			.map(({ item }) => String(item.aggregatedOutput ?? ""))
			.filter((output) => output.includes("export const target = 2;"));
		expect(readBacks.length).toBeGreaterThan(0);
		// 成功的那次写自己报的是 exitCode 0，action 依然是 unknown。
		const succeeded = frames.find(
			({ event, item }) =>
				event === "item/completed" &&
				item.type === "commandExecution" &&
				String(item.aggregatedOutput ?? "").includes(
					"Success. Updated the following files",
				),
		);
		expect(succeeded).toBeDefined();
		expect(succeeded?.item.exitCode).toBe(0);

		const replay = replayCodexFixture("write-turn-0.158", lines);
		// 读侧：结构化 `read` 动作落了一条足迹。
		expect(replay.snapshot.footprints.flatMap((fp) => fp.used)).toContain(
			"$DUMMY_REPO\\src\\target.ts",
		);
		// 写侧：一条都没有——`generated` 全空，所以 codex-router 的
		// `recordActivity` 拿到的是纯读足迹。
		expect(replay.snapshot.footprints.flatMap((fp) => fp.generated)).toEqual(
			[],
		);

		// 三次 apply_patch 尝试（两次失败 + 一次成功）连读足迹都不产生：它们的
		// commandActions 没有 path，而 command 字符串里也没有 `cat <path>` 可
		// 回退解析。注意成功那次走的是 codex 插件垫片
		// `codex.exe --codex-run-as-apply-patch`，命令串里连 `apply_patch`
		// 这个 token 都没有。
		const commandItems = distinctCommandItems(frames);
		expect(commandItems).toHaveLength(5);
		const writeAttempts = commandItems.filter(
			(item) =>
				String(item.command ?? "").includes("apply_patch") ||
				String(item.command ?? "").includes("--codex-run-as-apply-patch"),
		);
		expect(writeAttempts).toHaveLength(3);
		for (const item of writeAttempts) {
			expect(extractCodexFootprint(item, "probe")).toBeNull();
		}
	});

	test("the real write approvals are unattributable: kind=command, unknown action, no path", async () => {
		const raw = await readFile(WRITE_APPROVALS, "utf8");
		const fixture = JSON.parse(raw) as { requests: ApprovalRequest[] };

		// 同一个写回合里 5 次审批请求，全部是 commandExecution 审批。
		expect(fixture.requests.length).toBe(5);
		expect(fixture.requests.map((request) => request.id)).toEqual([
			0, 1, 2, 3, 4,
		]);
		for (const request of fixture.requests) {
			expect(request.method).toBe("item/commandExecution/requestApproval");
			expect(request.params.kind).toBe("command");

			const actions = Array.isArray(request.params.commandActions)
				? request.params.commandActions.map((action) => asRecord(action))
				: [];
			expect(actions.length).toBeGreaterThan(0);
			for (const action of actions) {
				expect(action.type).toBe("unknown");
				expect("path" in action).toBe(false);
			}

			// 写目标只出现在散文 reason 里，不在任何机器可读字段里。
			expect(String(request.params.reason)).toContain("src/target.ts");

			// `approvalTargets` 因此判成 unknown（而不是 write）：
			// paths 里只有 PATH_FIELDS 抓到的 cwd，没有写目标。
			const target = approvalTargets(request.method, request.params);
			expect(target.isApproval).toBe(true);
			expect(target.kind).toBe("unknown");
			expect(target.paths.some((path) => path.includes("target.ts"))).toBe(
				false,
			);

			// 于是 session.ts:225-229 的封印闸门（kind === "write" &&
			// paths.length > 0）不成立，连「不可归因」的 stderr 提示
			// （session.ts:250-254，同样要求 kind === "write"）也不会打印：
			// 默认策略的 accept 就是实际发回给 codex 的应答。
			expect(target.kind === "write" && target.paths.length > 0).toBe(false);
			expect(decideServerRequest(request.method)).toEqual({
				kind: "approval",
				decision: "accept",
			});
		}
	});

	test("the real write turn also carries shapes the render table has no decision for", async () => {
		// 这几行是 dump 的原样参数（归一化成 `type`-tagged 形态），不是本仓库的
		// 夹具：它们进不了 `streams/codex/`，因为那里的门禁要求每个夹具零
		// undecided。它们出现的次数（dump 全量）：outputDelta 82、
		// summaryTextDelta 71、summaryPartAdded 8、serverRequest/resolved 5、
		// warning 1、remoteControl/status/changed 1。
		for (const { key, event } of UNMODELED_REAL_SHAPES) {
			const result = reduceCodexRenderEvent(createCodexRenderState(), event);
			expect(result.decision, `${key} 现在有决策了：请更新这份读数`).toBe(
				"undecided",
			);
			expect(result.decisionKey).toBe(key);
		}
		// 后果（codex-router.ts:38-40 → codex-turn.ts:73-77）：回合仍然正常
		// 收尾，只在回合结束时 console.warn 一次未建模类型清单。
	});
});
