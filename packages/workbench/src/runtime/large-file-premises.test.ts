import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashPathClaim } from "../blackboard/footprint";
import { ChatThreads } from "../chat/threads";
import { makeTempWorkbench } from "../test/fixtures";
import { reconcilePremises } from "./premises";
import { diffReadSet } from "./read-set-diff";

test("size-only claims detect changes in both reconciliation and restore, without repeat noise", async () => {
	const ws = await makeTempWorkbench();
	try {
		const path = join(ws.projectDir, "large.txt");
		await writeFile(path, "a".repeat(2_000_001));
		const chat = new ChatThreads(ws.bb);
		const thread = await chat.create();
		const claim = await hashPathClaim(ws.projectDir, "large.txt");
		expect(claim.version).toBeNull();
		await ws.bb.sessions.recordActivity(thread.id, {
			activity: "read",
			agent: thread.id,
			used: [claim],
			generated: [],
		});
		const note = await chat.leave(thread.id);
		expect(note).toBeDefined();
		expect(await reconcilePremises(ws.bb)).toHaveLength(0);
		const fresh = await diffReadSet(ws.bb, thread.id, note?.leaveSignature);
		expect(fresh.comparable).toBe(1);
		expect(fresh.stale).toHaveLength(0);
		for (const size of [2_000_002, 2_000_003]) {
			await writeFile(path, "b".repeat(size));
			const notices = await reconcilePremises(ws.bb);
			expect(notices).toHaveLength(1);
			expect(notices[0]?.stale[0]?.currentVersion).toBe(`size:${size}`);
			expect(await reconcilePremises(ws.bb)).toHaveLength(0);
			const restored = await diffReadSet(
				ws.bb,
				thread.id,
				note?.leaveSignature,
			);
			expect(restored.stale).toHaveLength(1);
			expect(restored.stale[0]?.currentVersion).toBe(`size:${size}`);
		}
	} finally {
		await ws.cleanup();
	}
});
