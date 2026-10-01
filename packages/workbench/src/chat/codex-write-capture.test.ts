import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replayCodexFixture } from "../test/codex-fixture-replay";
import { createCodexAppServer } from "./codex-app-server";
import { approvalTargets } from "./codex-app-server/approval-targets";
import {
	FileChangePathIndex,
	fileChangeItemPaths,
	MAX_TRACKED_FILE_CHANGES,
} from "./codex-app-server/file-change-paths";
import {
	decideServerRequest,
	normalizeNotification,
} from "./codex-app-server/protocol";
import { extractCodexFootprint } from "./codex-footprint";
import {
	createCodexRenderState,
	reduceCodexRenderEvent,
} from "./codex-render-state";

/**
 * codex 写侧门禁（issue #31 / TF-0263 后续）。
 *
 * ADR-0017 §「本轮实现边界」把写侧记为「尚无证据」：11 个保留夹具只有
 * `read` / `listFiles`，`WRITE_ACTIONS`（edit / write / applyPatch / createFile）
 * 与 `fileChange` / `fileRead` item 类型都没有样本。
 *
 * **2026-09-27 的第一次抓取**用真实 codex `0.158.0-alpha.2.1` + 本地网关
 * （模型 `glm-5.3-flash`、read-only 沙箱、审批 on-request）抓到一个写回合：
 * 提示词要求模型用 `apply_patch` 把 `src/target.ts` 的 `target = 1` 改成 `2`。
 * 文件确实被改动，但那条流里没有任何原生写 item，审批的 `commandActions`
 * 也全部是 `type: "unknown"` 且没有 `path`。第一个补记据此写下「结构性缺席」。
 *
 * **同日的 6 变体重复实验否掉了那个结论**（`01`/`06` 两条变体发出了
 * `fileChange` item）。所以下面那批「零原生写 item」断言只对**它自己的夹具**
 * 成立——那是**回合间的方差**，不是结构性缺席；而变体 01 与第一次抓取是
 * **同一个模型、同一个 profile、同一个提示词**。真实写出的是原生 item，
 * 写目标在 item 的 `changes[].path` 上，审批只带 `params.itemId`——
 * 夹具与关联机制见 `fixtures/approvals/file-change-0.158.json` 与
 * `codex-app-server/file-change-paths.ts`。
 *
 * 更正记录：ADR-0017 的第二次 2026-09-27 补记；
 * 读数与诚实边界见 docs/handoff/2026-09-27-codex-filechange-seal.md。
 */
const FIXTURES = join(import.meta.dir, "fixtures");
const WRITE_TURN = join(FIXTURES, "streams/codex/write-turn-0.158.jsonl");
const WRITE_APPROVALS = join(FIXTURES, "approvals/apply-patch-0.158.json");
const FILE_CHANGE_TURNS = join(FIXTURES, "approvals/file-change-0.158.json");

/**
 * 原生写 item 类型。第一条抓取的夹具里一个都没有；`fileChange` 在变体
 * 01/06 里出现了（见本文件后半的 `native fileChange` 门禁），所以这里的
 * 「零」只对 `write-turn-0.158.jsonl` 这一个回合成立。
 */
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
	test("THIS turn's fixture (2026-09-27 capture #1) carries no native write item", async () => {
		const lines = await readJsonl(WRITE_TURN);
		const frames = itemFrames(lines);

		// The fixture is fed through the same reducer the live router uses.
		const replay = replayCodexFixture("write-turn-0.158", lines);
		expect(replay.snapshot.undecidedKeys).toEqual([]);

		// Only the four shapes the render table models appear in THIS fixture.
		// It is one turn's capture, not the车道's shape: variants 01/06 of the
		// same-day repetition emitted `fileChange` items (see the native-path
		// gate below), so a growing list here is variance, not a contradiction.
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
				`${type} 在这个夹具里出现了：这份夹具的读数变了，请重做`,
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

			// `approvalTargets` 因此判成 unknown（而不是 write）：paths 为空——
			// 写目标只出现在散文 reason 里，任何机器可读字段都没有。（`cwd`
			// 曾在 PATH_FIELDS 里，2026-09-27 移除：它是命令的运行目录，不是
			// 写目标；见 approval-targets.test.ts 的同名用例与
			// docs/handoff/2026-09-27-claim-hygiene-round.md。）
			const target = approvalTargets(request.method, request.params);
			expect(target.isApproval).toBe(true);
			expect(target.kind).toBe("unknown");
			expect(target.paths.some((path) => path.includes("target.ts"))).toBe(
				false,
			);

			// 于是 session.ts 的封印闸门（kind === "write" &&
			// paths.length > 0）不成立，默认策略的 accept 就是实际发回给
			// codex 的应答。诊断侧在第二次补记后改了：`kind === "unknown"`
			// 现在会打印一条「无法判定读/写，未咨询封印」——它不再声称这是
			// 一次写（判不出），但也不再用沉默代替记录。
			expect(target.kind === "write" && target.paths.length > 0).toBe(false);
			expect(decideServerRequest(request.method)).toEqual({
				kind: "approval",
				decision: "accept",
			});
		}
	});

	test("historical write-turn shapes distinguish newly modeled telemetry from remaining gaps", async () => {
		// 这几行是 dump 的原样参数（归一化成 `type`-tagged 形态），不是本仓库的
		// 夹具：它们进不了 `streams/codex/`，因为那里的门禁要求每个夹具零
		// undecided。它们出现的次数（dump 全量）：outputDelta 82、
		// summaryTextDelta 71、summaryPartAdded 8、serverRequest/resolved 5、
		// warning 1、remoteControl/status/changed 1。
		const modeled = new Set([
			"item/commandExecution/outputDelta",
			"item/reasoning/summaryTextDelta",
			"item/reasoning/summaryPartAdded",
			"serverRequest/resolved",
		]);
		for (const { key, event } of UNMODELED_REAL_SHAPES) {
			const result = reduceCodexRenderEvent(createCodexRenderState(), event);
			expect(result.decision, key).toBe(
				modeled.has(key) ? "noop" : "undecided",
			);
			expect(result.decisionKey).toBe(key);
		}
		// 后果（codex-router.ts:38-40 → codex-turn.ts:73-77）：回合仍然正常
		// 收尾，只在回合结束时 console.warn 一次未建模类型清单。
	});
});

/**
 * 第二次读数（2026-09-27，6 变体重复实验）：变体 01 与 06 发出了原生
 * `fileChange` item，所以「写侧结构性缺席」不成立。两条都沉淀在
 * `fixtures/approvals/file-change-0.158.json`：`items` 是 app-server 的原始
 * `{method, params}` 帧，`requests` 是随后的 `item/fileChange/requestApproval`。
 */
interface FileChangeTurn {
	label: string;
	model: string;
	sandbox: string;
	items: Array<{ method: string; params: Record<string, unknown> }>;
	requests: ApprovalRequest[];
}

async function readFileChangeTurns(): Promise<FileChangeTurn[]> {
	const raw = await readFile(FILE_CHANGE_TURNS, "utf8");
	return (JSON.parse(raw) as { turns: FileChangeTurn[] }).turns;
}

/** A turn's item frames in the `type`-tagged shape the live session sees. */
function normalizedItems(turn: FileChangeTurn): Record<string, unknown>[] {
	return turn.items.map((frame) =>
		normalizeNotification(frame.method, frame.params),
	);
}

describe("Codex native fileChange write (2026-09-27 capture #2)", () => {
	test("the path is on the item; the approval params have none; itemId joins them", async () => {
		const turns = await readFileChangeTurns();
		expect(turns.map((turn) => turn.label)).toEqual([
			"06-glm53flash-readonly-create",
			"01-glm53flash-readonly-patch",
		]);

		for (const turn of turns) {
			const frames = normalizedItems(turn);
			const fileChangeFrames = frames.filter(
				(frame) => asRecord(frame.item).type === "fileChange",
			);
			// (a) at least one native write item, carrying a real path.
			expect(
				fileChangeFrames.length,
				`${turn.label}: 没有 fileChange item`,
			).toBeGreaterThanOrEqual(1);
			const item = asRecord(fileChangeFrames[0]?.item);
			const changes = (item.changes as Array<Record<string, unknown>>) ?? [];
			expect(changes.length).toBeGreaterThan(0);
			const itemPaths = changes.map((change) => String(change.path));
			for (const path of itemPaths) {
				expect(typeof path).toBe("string");
				expect(path.length).toBeGreaterThan(0);
			}

			const extracted = fileChangeItemPaths(frames[0] ?? {});
			expect(typeof item.id).toBe("string");
			expect(extracted?.itemId).toBe(item.id as string);
			expect(extracted?.turnId).toBe(turn.items[0]?.params.turnId as string);
			expect(extracted?.paths).toEqual(itemPaths);

			// (b) the approval names the item and carries NO path. This is the
			// reason correlation is required rather than merely convenient.
			const request = turn.requests[0];
			if (!request) throw new Error(`${turn.label}: 缺审批请求`);
			expect(request.method).toBe("item/fileChange/requestApproval");
			expect(request.params.itemId).toBe(item.id);
			expect(Object.keys(request.params).sort()).toEqual(
				[
					"grantRoot",
					"itemId",
					"reason",
					"startedAtMs",
					"threadId",
					"turnId",
				].sort(),
			);
			expect(JSON.stringify(request.params)).not.toContain("path");

			// (c) WITHOUT correlation the seal gate cannot fire: kind is already
			// `write` (method-based) but there is nothing to seal. Pre-fix behaviour.
			const uncorrelated = approvalTargets(request.method, request.params);
			expect(uncorrelated.kind).toBe("write");
			expect(uncorrelated.paths).toEqual([]);
			expect(
				uncorrelated.kind === "write" && uncorrelated.paths.length > 0,
			).toBe(false);

			// (d) WITH correlation the same request resolves to the item's path and
			// the gate fires — the whole point of the fix.
			const index = new FileChangePathIndex();
			for (const frame of frames) index.note(frame);
			const correlated = approvalTargets(
				request.method,
				request.params,
				index.pathsFor(request.params.itemId),
			);
			expect(correlated.kind).toBe("write");
			expect(correlated.paths).toEqual(itemPaths);
			expect(correlated.kind === "write" && correlated.paths.length > 0).toBe(
				true,
			);
		}
	});

	test("the item→path index is pure, turn-scoped and capped", () => {
		const frame = (turnId: string, id: string, path: string) =>
			normalizeNotification("item/started", {
				item: {
					type: "fileChange",
					id,
					changes: [{ path }],
					status: "inProgress",
				},
				threadId: "t",
				turnId,
			});

		const index = new FileChangePathIndex();
		index.note(frame("turn_a", "call_a", "a.ts"));
		expect(index.pathsFor("call_a")).toEqual(["a.ts"]);
		// A non-`fileChange` item is not a write target.
		index.note(
			normalizeNotification("item/started", {
				item: { type: "agentMessage", id: "msg_1", text: "" },
				threadId: "t",
				turnId: "turn_a",
			}),
		);
		// A `fileChange` item with no readable path is skipped too.
		index.note(
			normalizeNotification("item/started", {
				item: { type: "fileChange", id: "call_bare", changes: [] },
				threadId: "t",
				turnId: "turn_a",
			}),
		);
		expect(index.pathsFor("msg_1")).toEqual([]);
		expect(index.pathsFor("call_bare")).toEqual([]);

		// A new turn drops the previous turn's items.
		index.note(frame("turn_b", "call_b", "b.ts"));
		expect(index.pathsFor("call_a")).toEqual([]);
		expect(index.pathsFor("call_b")).toEqual(["b.ts"]);

		// Unknown / non-string ids resolve to nothing rather than throwing.
		expect(index.pathsFor("missing")).toEqual([]);
		expect(index.pathsFor(undefined)).toEqual([]);
		expect(index.pathsFor(42)).toEqual([]);

		// Bounded, oldest-first: the map cannot grow without limit.
		for (let i = 0; i <= MAX_TRACKED_FILE_CHANGES; i++) {
			index.note(frame("turn_b", `call_${i}`, `f${i}.ts`));
		}
		expect(index.size).toBe(MAX_TRACKED_FILE_CHANGES);
		expect(index.pathsFor("call_b")).toEqual([]);
		expect(index.pathsFor(`call_${MAX_TRACKED_FILE_CHANGES}`)).toEqual([
			`f${MAX_TRACKED_FILE_CHANGES}.ts`,
		]);

		index.clear();
		expect(index.size).toBe(0);
		expect(index.pathsFor(`call_${MAX_TRACKED_FILE_CHANGES}`)).toEqual([]);
	});
});

/**
 * A fake app-server that reproduces capture #2's ordering: an unclassifiable
 * command approval, then the native `fileChange` item, then ITS approval (which
 * names the item). The replies the lane sends back are recorded to a file, so the
 * assertions read what actually went on the wire rather than a re-derivation.
 */
const FAKE_FILE_CHANGE_SERVER = String.raw`
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const notify = (method, params) => send({ method, params });
const threadId = "thread_fake_write";
const turnId = "turn_fake_write";
const itemId = "call_fake_write";
const target = join(process.cwd(), "src", "target.ts");
const repliesPath = join(process.cwd(), "approval-decisions.json");
const decisions = [];
let turnRequestId = null;
let awaiting = 0;
const settle = () => {
  awaiting -= 1;
  if (awaiting > 0) return;
  notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: "msg_fake_1", text: "done", phase: "final_answer" } });
  notify("turn/completed", { threadId, turn: { id: turnId, status: "completed" } });
  send({ id: turnRequestId, result: { ok: true } });
};
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") { send({ id: msg.id, result: { ok: true } }); continue; }
  if (msg.method === "initialized") continue;
  if (msg.method === "thread/start") { send({ id: msg.id, result: { thread: { id: threadId } } }); continue; }
  if (msg.method === "turn/start") {
    turnRequestId = msg.id;
    awaiting = 2;
    notify("turn/started", { threadId, turn: { id: turnId } });
    send({ id: 900, method: "item/commandExecution/requestApproval", params: {
      kind: "command", threadId, turnId, itemId: "call_fake_cmd", startedAtMs: 1,
      reason: "allow this command?", command: "npm test",
      commandActions: [{ type: "unknown", command: "npm test" }],
    }});
    notify("item/started", { threadId, turnId, item: {
      type: "fileChange", id: itemId,
      changes: [{ path: target, kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-1\n+2\n" }],
      status: "inProgress",
    }});
    send({ id: 901, method: "item/fileChange/requestApproval", params: {
      threadId, turnId, itemId, startedAtMs: 2, reason: null, grantRoot: null,
    }});
    continue;
  }
  if (msg.id !== undefined && msg.method === undefined) {
    decisions.push({ id: msg.id, result: msg.result });
    writeFileSync(repliesPath, JSON.stringify(decisions));
    settle();
  }
}
`;

describe("Codex native fileChange approval reaches the seal (TF-0263 follow-up)", () => {
	test("session correlates params.itemId to the item's path, seals, and cancels", async () => {
		const dir = await mkdtemp(join(tmpdir(), "codex-filechange-"));
		await mkdir(join(dir, "proc"), { recursive: true });
		const script = join(dir, "fake-codex-filechange.mjs");
		await writeFile(script, FAKE_FILE_CHANGE_SERVER);
		const sealed: Array<{ kind: string; paths: string[] }> = [];
		const stderr: string[] = [];
		const server = createCodexAppServer({
			cwd: dir,
			registryDir: join(dir, "proc"),
			label: "chat:test-filechange",
			commandLine: `"${process.execPath}" "${script}"`,
			onEvent: () => {},
			onStderr: (line) => stderr.push(line),
			sealApproval: async (target) => {
				sealed.push({ kind: target.kind, paths: [...target.paths] });
				return { blocked: true };
			},
		});
		try {
			await server.initialize();
			const threadId = await server.startThread({ cwd: dir });
			await server.startTurn(threadId, "write src/target.ts");

			// The seal was consulted exactly once, with the item's real path.
			expect(sealed).toEqual([
				{ kind: "write", paths: [join(dir, "src", "target.ts")] },
			]);

			const decisions = JSON.parse(
				await readFile(join(dir, "approval-decisions.json"), "utf8"),
			) as Array<{ id: number; result: { decision?: string } }>;
			// A blocked native write is cancelled (0.158 has no `decline`).
			expect(decisions.find((entry) => entry.id === 901)?.result).toEqual({
				decision: "cancel",
			});
			// The unclassifiable command approval is still accepted by default —
			// but no longer silently: it now prints the unattributable diagnostic.
			expect(decisions.find((entry) => entry.id === 900)?.result).toEqual({
				decision: "accept",
			});
			expect(
				stderr.some((line) => line.includes("无法判定读/写，未咨询封印")),
			).toBe(true);
		} finally {
			await server.shutdown().catch(() => {});
			await rm(dir, { recursive: true, force: true });
		}
	}, 20_000);
});
