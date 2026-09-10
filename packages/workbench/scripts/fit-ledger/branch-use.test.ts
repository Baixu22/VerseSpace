import { expect, test } from "bun:test";
import { collectChatStats } from "../../src/chat/stats";
import { ChatThreads } from "../../src/chat/threads";
import { makeTempWorkbench } from "../../src/test/fixtures";
import { buildRows } from "./ledger";

test("R10 查看分支用已有动作入账，其他恢复动作不冒充消费", async () => {
	const ws = await makeTempWorkbench();
	try {
		const chat = new ChatThreads(ws.bb);
		const thread = await chat.create();
		await chat.recordResumeAction(thread.id, "resume_card_revealed");
		await chat.recordResumeAction(thread.id, "resume_branch_opened");
		const [row] = buildRows(
			[{ id: "TF-0151", title: "R10", kind: "task", status: "done" }],
			{
				stats: await collectChatStats(ws.bb),
				events: await ws.bb.events.all(),
				writerKind: new Map([[thread.id, "agent"]]),
			},
		);
		expect(row).toMatchObject({
			kind: "component",
			value: 1,
			samples: 1,
			fit: "partial",
		});
	} finally {
		await ws.cleanup();
	}
});

test("通知预算节点只以 delivered 入账，排队不冒充交付", async () => {
	const ws = await makeTempWorkbench();
	try {
		const thread = await new ChatThreads(ws.bb).create();
		for (const type of ["premise_notice_queued", "premise_notice_delivered"])
			await ws.bb.events.append({
				timestamp: new Date().toISOString(),
				source: "runtime",
				type,
				payload: { writer: thread.id, noticeId: "test-notice" },
			});
		const [row] = buildRows(
			[{ id: "TF-0133", title: "通知预算", kind: "task", status: "done" }],
			{
				stats: await collectChatStats(ws.bb),
				events: await ws.bb.events.all(),
				writerKind: new Map([[thread.id, "agent"]]),
			},
		);
		expect(row).toMatchObject({
			kind: "component",
			value: 1,
			samples: 1,
			fit: "partial",
		});
	} finally {
		await ws.cleanup();
	}
});
