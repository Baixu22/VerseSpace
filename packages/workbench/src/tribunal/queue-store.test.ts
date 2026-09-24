import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildProgram } from "../cli";
import { makeTempWorkbench } from "../test/fixtures";
import type { TribunalCandidate } from "../types/tribunal";

/**
 * The queue exists to hold the human decisions the system could not answer, so
 * the one outcome it must never produce is a *silently* shorter queue: an item
 * that fails to parse is a decision that disappears from every surface, and a
 * queue missing one item reads exactly like a queue with nothing to decide.
 * These tests pin the second half of that contract — the item stays out of the
 * list (one bad file must not hide the others) but it is counted and named.
 */

function candidate(
	overrides: Partial<TribunalCandidate> = {},
): TribunalCandidate {
	return {
		kind: "workspot_blocked",
		subject: "ws-a",
		causeKey: "workspot_blocked:ws-a",
		action: {
			label: "重新指派工位",
			command: "workbench ws reassign ws-a --task g-2",
		},
		sbar: {
			situation: "工位 ws-a 被阻塞",
			background: "任务 g-1 已进入 stale_done",
			assessment: "工位空转，本轮产出为零",
			recommendation: "把 ws-a 改派到 g-2，或关闭它",
		},
		...overrides,
	};
}

/** A crash mid-write / a hand edit leaves YAML the schema cannot accept. */
async function seedTornItem(tribunalDir: string): Promise<string> {
	const name = "t-torn.yaml";
	await writeFile(
		join(tribunalDir, name),
		"id: t-torn\nkind: [unclosed\n",
		"utf8",
	);
	return name;
}

describe("tribunal queue readability", () => {
	test("a torn item is counted as unreadable, not silently dropped", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			const submitted = await bb.tribunal.submit(candidate());
			expect(submitted.admitted).toBe(true);
			const torn = await seedTornItem(bb.paths.tribunal);

			// the queue stays readable: one bad file does not break the rest
			const open = await bb.tribunal.list();
			expect(open).toHaveLength(1);
			// ... and the bad one is not pretending not to exist
			expect(await bb.tribunal.unreadable()).toEqual([torn]);
		} finally {
			await cleanup();
		}
	});

	test("an unreadable entry is not reported as an empty queue by the CLI", async () => {
		const ws = await makeTempWorkbench();
		const cwd = process.cwd();
		process.chdir(ws.projectDir);
		const lines: string[] = [];
		const originalLog = console.log;
		console.log = (...parts: unknown[]) => void lines.push(parts.join(" "));
		try {
			const torn = await seedTornItem(ws.bb.paths.tribunal);
			await buildProgram().parseAsync([
				"node",
				"workbench",
				"tribunal",
				"list",
			]);
			const output = lines.join("\n");
			expect(output).toContain("1 条无法读取");
			expect(output).toContain(torn);
		} finally {
			console.log = originalLog;
			process.chdir(cwd);
			await ws.cleanup();
		}
	});

	test("--json carries the unreadable names as data, not prose", async () => {
		const ws = await makeTempWorkbench();
		const cwd = process.cwd();
		process.chdir(ws.projectDir);
		const lines: string[] = [];
		const originalLog = console.log;
		console.log = (...parts: unknown[]) => void lines.push(parts.join(" "));
		try {
			const torn = await seedTornItem(ws.bb.paths.tribunal);
			await buildProgram().parseAsync([
				"node",
				"workbench",
				"tribunal",
				"list",
				"--json",
			]);
			const payload = JSON.parse(lines.join("\n")) as {
				tribunal: unknown[];
				unreadable: string[];
			};
			expect(payload.tribunal).toHaveLength(0);
			expect(payload.unreadable).toEqual([torn]);
		} finally {
			console.log = originalLog;
			process.chdir(cwd);
			await ws.cleanup();
		}
	});
});
