import { expect, test } from "bun:test";

import { makeTempWorkbench } from "../../test/fixtures";
import type { WorkbenchEvent } from "../../types/event";
import {
	buildBranchL1Summary,
	l1SummaryRefs,
	renderL1Summary,
} from "./l1-summary";

const at = (offsetMs: number) =>
	new Date(Date.parse("2026-09-19T00:00:00Z") + offsetMs).toISOString();

function footprintEvent(input: {
	id: string;
	writer: string;
	generated: Array<{ path: string; version?: string }>;
	at?: string;
}): WorkbenchEvent {
	return {
		id: input.id,
		timestamp: input.at ?? at(1_000),
		source: "sessions",
		type: "footprint",
		payload: {
			writer: input.writer,
			activity: `act-${input.id}`,
			used: [],
			generated: input.generated,
		},
	};
}

function premiseStaleEvent(input: {
	id: string;
	writer: string;
}): WorkbenchEvent {
	return {
		id: input.id,
		timestamp: at(2_000),
		source: "runtime",
		type: "premise_stale",
		payload: {
			writer: input.writer,
			stale: [{ path: "src/alpha.ts", currentVersion: "v2" }],
		},
	};
}

const BRANCH = { id: "thread-branch", title: "分支工作" };
// 恒真边界（测试直接控制 events 数组的内容）。
const alwaysAfter = () => true;

test("空分支零痕迹：无账本条目 → 零行、渲染为空串", async () => {
	const ws = await makeTempWorkbench();
	try {
		const summary = await buildBranchL1Summary({
			bb: ws.bb,
			branch: BRANCH,
			isAfterLeave: alwaysAfter,
			events: [],
			counterpartyWrites: new Set(),
		});
		expect(summary.lines).toEqual([]);
		expect(renderL1Summary(summary)).toBe("");
		expect(l1SummaryRefs(summary)).toEqual([]);
	} finally {
		await ws.cleanup();
	}
});

test("每行事实带 refs：账本差与写集（N 文件, hash）", async () => {
	const ws = await makeTempWorkbench();
	try {
		const events = [
			footprintEvent({
				id: "fp-1",
				writer: BRANCH.id,
				generated: [{ path: "src/alpha.ts", version: "aaaa1111bbbb" }],
			}),
			footprintEvent({
				id: "fp-2",
				writer: BRANCH.id,
				generated: [{ path: "src/beta.ts", version: "cccc2222dddd" }],
			}),
		];
		const summary = await buildBranchL1Summary({
			bb: ws.bb,
			branch: BRANCH,
			isAfterLeave: alwaysAfter,
			events,
			counterpartyWrites: new Set(),
		});
		const kinds = summary.lines.map((line) => line.kind);
		// 分支有活动且无 checkpoint：账本差、写集之后追加「未经 Verifier」。
		expect(kinds).toEqual(["ledger", "writes", "verifier"]);
		const ledger = summary.lines[0]!;
		expect(ledger.text).toBe("账本新增 2 条足迹");
		expect(ledger.refs).toEqual(["fp-1", "fp-2"]);
		const writes = summary.lines[1]!;
		expect(writes.text).toContain("写集 2 文件");
		expect(writes.text).toContain("src/alpha.ts@aaaa1111");
		expect(writes.refs).toEqual(["fp-1", "fp-2"]);
		// refs 完整性：并集恰好是各行的并集，无遗漏无虚构。
		expect(l1SummaryRefs(summary)).toEqual([
			...new Set(summary.lines.flatMap((line) => line.refs)),
		]);
	} finally {
		await ws.cleanup();
	}
});

test("接口 Δ：写的路径撞上注册接口且 hash 漂移，refs 含 iface 键", async () => {
	const ws = await makeTempWorkbench();
	try {
		await ws.bb.interfaces.register({
			key: "core/api",
			canonicalPath: "src/api.ts",
			version: 1,
			publishedBy: "human",
			lastModified: at(0),
			contentHash: "oldhash",
			subscribers: [],
		});
		const events = [
			footprintEvent({
				id: "fp-1",
				writer: BRANCH.id,
				generated: [{ path: "src/api.ts", version: "newhash" }],
			}),
		];
		const summary = await buildBranchL1Summary({
			bb: ws.bb,
			branch: BRANCH,
			isAfterLeave: alwaysAfter,
			events,
			counterpartyWrites: new Set(),
		});
		const iface = summary.lines.find((line) => line.kind === "interfaces");
		expect(iface).toBeDefined();
		expect(iface!.text).toContain("接口 Δ 1 项");
		expect(iface!.text).toContain("core/api");
		expect(iface!.refs).toContain("iface:core/api");
		expect(iface!.refs).toContain("fp-1");
	} finally {
		await ws.cleanup();
	}
});

test("merge-guard 预测：与本线程写集重叠才成行", async () => {
	const ws = await makeTempWorkbench();
	try {
		const events = [
			footprintEvent({
				id: "fp-1",
				writer: BRANCH.id,
				generated: [
					{ path: "src/shared.ts", version: "aaaa" },
					{ path: "src/only-branch.ts", version: "bbbb" },
				],
			}),
		];
		const withOverlap = await buildBranchL1Summary({
			bb: ws.bb,
			branch: BRANCH,
			isAfterLeave: alwaysAfter,
			events,
			counterpartyWrites: new Set(["src/shared.ts"]),
		});
		const merge = withOverlap.lines.find((line) => line.kind === "merge");
		expect(merge).toBeDefined();
		expect(merge!.text).toContain("重叠 1 文件");
		expect(merge!.text).toContain("src/shared.ts");
		expect(merge!.refs).toEqual(["fp-1"]);

		const withoutOverlap = await buildBranchL1Summary({
			bb: ws.bb,
			branch: BRANCH,
			isAfterLeave: alwaysAfter,
			events,
			counterpartyWrites: new Set(),
		});
		expect(withoutOverlap.lines.some((line) => line.kind === "merge")).toBe(
			false,
		);
	} finally {
		await ws.cleanup();
	}
});

test("R3：有 verified checkpoint 必并列失效前提数（k=0 也并列），且不出现「未经 Verifier」", async () => {
	const ws = await makeTempWorkbench();
	try {
		await ws.bb.checkpoints.save(
			{
				id: "cp-1",
				goal: "g-1",
				workspot: "ws-a",
				timestamp: at(3_000),
				lifecycle: "verified",
				assertion: "测试全绿",
				artifacts: [],
				unblocks: [],
				threadId: BRANCH.id,
				verificationResult: { status: "pass", at: at(3_000) },
			},
			"verified",
		);
		const summary = await buildBranchL1Summary({
			bb: ws.bb,
			branch: BRANCH,
			isAfterLeave: alwaysAfter,
			events: [],
			counterpartyWrites: new Set(),
		});
		const verifier = summary.lines.find((line) => line.kind === "verifier");
		expect(verifier).toBeDefined();
		expect(verifier!.text).toContain("Verifier 已验证（checkpoint cp-1）");
		expect(verifier!.text).toContain("分支自身 0 个前提已失效");
		expect(verifier!.text).not.toContain("未经 Verifier");
		expect(verifier!.refs).toContain("cp-1");
	} finally {
		await ws.cleanup();
	}
});

test("R3：checkpoint 存在但无验证结论 → 引用 id 但不用「未经 Verifier」措辞", async () => {
	const ws = await makeTempWorkbench();
	try {
		await ws.bb.checkpoints.save(
			{
				id: "cp-draft",
				goal: "g-1",
				workspot: "ws-a",
				timestamp: at(3_000),
				lifecycle: "draft",
				assertion: "待验证",
				artifacts: [],
				unblocks: [],
				threadId: BRANCH.id,
			},
			"staging",
		);
		const summary = await buildBranchL1Summary({
			bb: ws.bb,
			branch: BRANCH,
			isAfterLeave: alwaysAfter,
			events: [premiseStaleEvent({ id: "e-stale", writer: BRANCH.id })],
			counterpartyWrites: new Set(),
		});
		const verifier = summary.lines.find((line) => line.kind === "verifier");
		expect(verifier).toBeDefined();
		expect(verifier!.text).toContain("checkpoint cp-draft");
		expect(verifier!.text).toContain("分支自身 1 个前提已失效");
		expect(verifier!.text).not.toContain("未经 Verifier");
		// 失效前提的溯源进 verifier 行
		expect(verifier!.refs).toContain("e-stale");
	} finally {
		await ws.cleanup();
	}
});

test("R3：无 checkpoint 才允许「未经 Verifier」，且失效前提单独成行", async () => {
	const ws = await makeTempWorkbench();
	try {
		const events = [
			footprintEvent({
				id: "fp-1",
				writer: BRANCH.id,
				generated: [{ path: "src/alpha.ts", version: "aaaa" }],
			}),
			premiseStaleEvent({ id: "e-stale", writer: BRANCH.id }),
		];
		const summary = await buildBranchL1Summary({
			bb: ws.bb,
			branch: BRANCH,
			isAfterLeave: alwaysAfter,
			events,
			counterpartyWrites: new Set(),
		});
		const verifier = summary.lines.find((line) => line.kind === "verifier");
		expect(verifier).toBeDefined();
		expect(verifier!.text).toBe("未经 Verifier");
		expect(verifier!.text).not.toContain("checkpoint");
		// 「未经 Verifier」的 refs 溯源到未经它验证的账本事实
		expect(verifier!.refs).toContain("fp-1");
		const premises = summary.lines.find((line) => line.kind === "premises");
		expect(premises).toBeDefined();
		expect(premises!.text).toBe("分支自身 1 个前提已失效");
		expect(premises!.refs).toEqual(["e-stale"]);
	} finally {
		await ws.cleanup();
	}
});
