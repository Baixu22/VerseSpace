import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashPathClaim } from "../blackboard/footprint";
import { makeTempWorkbench } from "../test/fixtures";
import { pendingPremiseNotices } from "./delivery";
import { reconcilePremises } from "./premises";
import { surfaceHash } from "./surface";

test("TF-0107: punctuation spacing is invisible, literal whitespace remains meaningful", () => {
	expect(surfaceHash("export function f(a:number):number {return a;}")).toBe(
		surfaceHash("export function f ( a : number ) : number { return a; }"),
	);
	expect(surfaceHash('export type T = "a b";')).not.toBe(
		surfaceHash('export type T = "a  b";'),
	);
	expect(surfaceHash('export type T = "a;{b";')).not.toBe(
		surfaceHash('export type T = "a;{c";'),
	);
	expect(surfaceHash('export type T = "a\\" b";')).not.toBe(
		surfaceHash('export type T = "a\\"  b";'),
	);
});

test("TF-0107: a formatting-only dependency edit creates no notice, a literal-type change does", async () => {
	const ws = await makeTempWorkbench();
	try {
		const path = join(ws.projectDir, "api.ts");
		const original =
			'export function f(a:number):number {return a;}\nexport type T = "a b";\n';
		await writeFile(path, original);
		await ws.bb.sessions.register("reader", "agent", "reader");
		await ws.bb.sessions.recordActivity("reader", {
			activity: "read-api",
			agent: "reader",
			generated: [],
			used: [
				await hashPathClaim(
					ws.projectDir,
					"api.ts",
					join(ws.workbenchRoot, "sessions", "reader", "spool"),
				),
			],
		});
		await writeFile(
			path,
			'export function f ( a : number ) : number { return a; }\nexport type T="a b";\n',
		);
		expect(await reconcilePremises(ws.bb)).toEqual([]);
		expect(await ws.bb.events.query({ type: "premise_stale" })).toEqual([]);
		expect(await pendingPremiseNotices(ws.bb)).toEqual([]);
		await writeFile(path, original.replace('"a b"', '"a  b"'));
		const notices = await reconcilePremises(ws.bb);
		expect(notices).toHaveLength(1);
		expect(notices[0]?.stale[0]?.path).toBe("api.ts");
	} finally {
		await ws.cleanup();
	}
});
