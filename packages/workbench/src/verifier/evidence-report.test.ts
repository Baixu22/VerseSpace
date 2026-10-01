import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { makeTempWorkbench } from "../test/fixtures";
import { runVerification } from "./index";

test("real Vitest JSON reporter matches exact names and skipped counts", async () => {
	const ws = await makeTempWorkbench();
	try {
		await writeFile(
			join(ws.projectDir, "vitest.config.mjs"),
			"export default { test: { globals: true, include: ['case.test.mjs'], maxWorkers: 1, minWorkers: 1 } };",
		);
		const path = join(ws.projectDir, "case.test.mjs");
		await writeFile(
			path,
			"describe('contract', () => { test('reads', () => expect(1).toBe(1)); test('writes', () => expect(2).toBe(2)); });",
		);
		const verification = {
			strategy: "test" as const,
			command: `node "${resolve(import.meta.dir, "../../../../node_modules/vitest/vitest.mjs")}" run --config vitest.config.mjs --reporter=json --outputFile=report.json`,
			evidence: {
				report: {
					format: "vitest-json" as const,
					path: "report.json",
					expectedTests: ["contract reads", "contract writes"],
				},
				inputs: [],
			},
		};
		const result = await runVerification(verification, ws.projectDir);
		expect(result.status).toBe("passed");
		expect(result.evidence?.status).toBe("satisfied");
		expect(result.evidence?.counts.passed).toBe(2);
		await writeFile(
			path,
			"describe('contract', () => { test('reads', () => expect(1).toBe(1)); test.skip('writes', () => {}); });",
		);
		const skipped = await runVerification(verification, ws.projectDir);
		expect(skipped.status).toBe("passed");
		expect(skipped.evidence?.status).toBe("unsatisfied");
		expect(skipped.evidence?.counts.skipped).toBe(1);
	} finally {
		await ws.cleanup();
	}
}, 60_000);
