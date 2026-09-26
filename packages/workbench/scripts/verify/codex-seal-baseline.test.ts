import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { reconcilePremises } from "../../src/runtime/premises";
import { judgeSeal } from "../../src/runtime/seal";
import { makeTempWorkbench } from "../../src/test/fixtures";
import { probeCase, sealBaseline } from "./codex-seal-baseline";

test("probe case defaults correctly and rejects missing or unknown values", () => {
	expect(probeCase(["--json"])).toBe("own-stale");
	expect(probeCase(["--case", "own-fresh"])).toBe("own-fresh");
	expect(() => probeCase(["--case"])).toThrow();
	expect(() => probeCase(["--case", "stale"])).toThrow();
});

test("the control uses the lane's own latest claims; another writer cannot stand in", async () => {
	const ws = await makeTempWorkbench();
	try {
		const target = "target.txt";
		await writeFile(join(ws.projectDir, target), "v1");
		for (const writer of ["lane", "other"]) {
			await ws.bb.sessions.register(writer, "agent", writer);
			await ws.bb.sessions.recordActivity(writer, {
				activity: "read",
				agent: writer,
				used: [{ path: target, version: null }],
				generated: [],
			});
		}
		expect(
			(await sealBaseline(ws.bb, "lane", target, false)).claims,
		).toHaveLength(0);
		await writeFile(join(ws.projectDir, target), "v2");
		await reconcilePremises(ws.bb);
		const baseline = await sealBaseline(ws.bb, "lane", target, true);
		expect(baseline.writerId).toBe("lane");
		expect(baseline.claims).toHaveLength(1);
		expect(
			judgeSeal(ws.projectDir, baseline.target, baseline.claims).blocked,
		).toBe(true);
		await expect(
			sealBaseline(ws.bb, "unobserved", target, true),
		).rejects.toThrow("足迹");
		await expect(sealBaseline(ws.bb, "lane", target, false)).rejects.toThrow(
			"前提状态",
		);
	} finally {
		await ws.cleanup();
	}
});
