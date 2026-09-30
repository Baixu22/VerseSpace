import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashText } from "../hash";
import { makeTempWorkbench } from "../test/fixtures";
import { normalizeNotification } from "./codex-app-server/protocol";
import { createCodexRenderState } from "./codex-render-state";
import { type CodexTurnState, routeCodexEvent } from "./codex-router";
import type { ThreadContext } from "./thread-context";

test("retained native create/update frames render and capture only completed writes, once", async () => {
	const ws = await makeTempWorkbench();
	try {
		await ws.bb.sessions.register("w", "agent");
		const fixture = JSON.parse(
			await readFile(
				join(import.meta.dir, "fixtures/approvals/file-change-0.158.json"),
				"utf8",
			),
		);
		for (const [i, sample] of fixture.turns.entries()) {
			const path = `native-${i}.txt`;
			await writeFile(join(ws.projectDir, path), "written");
			const turn: CodexTurnState = {
				render: createCodexRenderState(),
				pendingFootprints: new Map(),
				fpQueue: Promise.resolve(),
				undecidedEventTypes: new Set(),
				emit: () => {},
			};
			for (const frame of sample.items) {
				const event = normalizeNotification(frame.method, frame.params)!;
				const item = event.item as { changes: Array<{ path: string }> };
				item.changes[0]!.path = path; // only relocate the retained fixture's absolute path
				routeCodexEvent({ bb: ws.bb } as ThreadContext, "w", turn, event);
				await turn.fpQueue;
			}
			expect(turn.undecidedEventTypes.size).toBe(0);
			expect(
				turn.render.messageParts.some(
					(part) => part.type === "tool-call" && part.toolName === "fileChange",
				),
			).toBe(true);
			const last = sample.items.at(-1);
			routeCodexEvent(
				{ bb: ws.bb } as ThreadContext,
				"w",
				turn,
				normalizeNotification(last.method, last.params)!,
			);
			await turn.fpQueue;
		}
		const lines = await ws.bb.sessions.footprint("w");
		expect(lines).toHaveLength(2);
		expect(
			lines.every(
				(line) =>
					line.used.length === 0 &&
					line.generated[0]?.version === hashText("written"),
			),
		).toBe(true);
		for (const status of ["declined", "failed", "inProgress", "unknown"]) {
			const turn: CodexTurnState = {
				render: createCodexRenderState(),
				pendingFootprints: new Map(),
				fpQueue: Promise.resolve(),
				undecidedEventTypes: new Set(),
				emit: () => {},
			};
			routeCodexEvent({ bb: ws.bb } as ThreadContext, "w", turn, {
				type: "item/completed",
				item: {
					type: "fileChange",
					id: status,
					changes: [{ path: "native-0.txt" }],
					status,
				},
			});
			await turn.fpQueue;
		}
		expect(await ws.bb.sessions.footprint("w")).toHaveLength(2);
	} finally {
		await ws.cleanup();
	}
});
