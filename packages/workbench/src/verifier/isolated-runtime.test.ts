import { expect, test } from "bun:test";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { consumeArtifact } from "../artifacts/consume";
import { listArtifactReviews } from "../artifacts/status";
import { hashText } from "../hash";
import { verificationStalenessReason } from "../runtime/verification-binding";
import { verifyCheckpoint } from "../runtime/verify-checkpoint";
import { seedArtifactUse } from "../test/artifact-use-fixture";
import { makeTempWorkbench } from "../test/fixtures";
import { fixedObjectCurrentIssue } from "./fixed-object";
import { runVerification } from "./index";
import { verificationObjectDigest } from "./isolated-files";

async function makeFixed() {
	const ws = await seedArtifactUse();
	const cp = (await ws.bb.checkpoints.scanZone("verified"))[0]!;
	const fixed = {
		...cp,
		id: "fixed",
		lifecycle: "draft" as const,
		verification: {
			...cp.verification!,
			command: undefined,
			evidence: {
				...cp.verification!.evidence!,
				fixedFiles: {
					mode: "node-offline-files-v1" as const,
					script: "check.cjs",
					complete: true as const,
				},
			},
		},
	};
	await ws.bb.checkpoints.save(fixed, "staging");
	return { ...ws, cp: fixed };
}

test("runtime binds a fixed object and consumes its archived report without source report inheritance", async () => {
	const ws = await makeFixed();
	try {
		await verifyCheckpoint(ws.bb, "fixed", []);
		const cp = (await ws.bb.checkpoints.scanZone("verified")).find(
			(cp) => cp.id === "fixed",
		)!;
		expect(cp.lifecycle, JSON.stringify(cp.verificationBindingIssue)).toBe(
			"verified",
		);
		expect(
			cp.verificationResult?.object?.files.find(
				(file) => file.path === "api.txt",
			)?.hash,
		).toBe(hashText("v1"));
		// A forged live-workspace report cannot replace this check's immutable report.
		await writeFile(join(ws.projectDir, "report.json"), "{}");
		expect((await consumeArtifact(ws.bb, "fixed", "fixed")).ok).toBe(true);
		const consumed = (await ws.bb.checkpoints.scanZone("verified")).find(
			(cp) => cp.id === "fixed",
		)!;
		expect(consumed.artifactConsumption?.reportHash).toBe(
			cp.verificationResult?.object?.reportHash,
		);
		const object = cp.verificationResult!.object!;
		await writeFile(
			join(ws.workbenchRoot, "checkpoints", "objects", object.reportFile!),
			"{}",
		);
		expect(await verificationStalenessReason(ws.bb, cp)).toContain("报告");
		await writeFile(join(ws.projectDir, "api.txt"), "v2");
		expect(
			(await listArtifactReviews(ws.bb)).find((row) => row.rootId === "fixed")
				?.status,
		).toBe("stale");
	} finally {
		await ws.cleanup();
	}
});

test("removing an input from the execution manifest cannot retain a valid current object", async () => {
	const ws = await makeFixed();
	try {
		await verifyCheckpoint(ws.bb, "fixed", []);
		const cp = (await ws.bb.checkpoints.scanZone("verified")).find(
			(cp) => cp.id === "fixed",
		)!;
		const object = structuredClone(cp.verificationResult!.object!);
		object.files = object.files.filter((file) => file.path !== "api.txt");
		object.manifestHash = verificationObjectDigest(object);
		expect(
			await fixedObjectCurrentIssue(object, ws.projectDir, {
				artifact: cp.artifact!,
				verification: cp.verification!,
			}),
		).toContain("集合");
	} finally {
		await ws.cleanup();
	}
});

test("an offline child that exceeds its declared deadline is timeout, never passed", async () => {
	const ws = await makeFixed();
	try {
		await writeFile(
			join(ws.projectDir, "check.cjs"),
			"setInterval(()=>{},1000);",
		);
		const result = await runVerification(
			{ ...ws.cp.verification!, timeout: 1 },
			ws.projectDir,
			10,
			{
				artifact: ws.cp.artifact,
				recordDir: join(ws.workbenchRoot, "checkpoints", "objects"),
			},
		);
		expect(result.status).toBe("timeout");
		expect(result.object?.runMs).toBeGreaterThanOrEqual(1000);
	} finally {
		await ws.cleanup();
	}
});

test("runtime preserves passed copy result but refuses current binding after concurrent source modification", async () => {
	const ws = await makeFixed();
	try {
		const original = await readFile(join(ws.projectDir, "check.cjs"), "utf8");
		await writeFile(
			join(ws.projectDir, "check.cjs"),
			`setTimeout(()=>{${original}},500);`,
		);
		const pending = verifyCheckpoint(ws.bb, "fixed", []);
		const recordDir = join(ws.workbenchRoot, "checkpoints", "objects");
		const deadline = Date.now() + 8000;
		let ready = false;
		while (Date.now() < deadline && !ready) {
			for (const name of await readdir(recordDir).catch(() => [])) {
				ready ||= !!(await stat(
					join(recordDir, name, "files", ".workbench-fixed-plan.json"),
				).catch(() => null));
			}
			if (!ready) await Bun.sleep(10);
		}
		if (!ready) throw new Error("fixed copy did not become ready");
		await writeFile(join(ws.projectDir, "api.txt"), "v2");
		await pending;
		const cp = (await ws.bb.checkpoints.scanZone("staging")).find(
			(cp) => cp.id === "fixed",
		)!;
		expect(cp.verificationResult?.status).toBe("passed");
		expect(
			cp.verificationResult?.object?.files.find(
				(file) => file.path === "api.txt",
			)?.hash,
		).toBe(hashText("v1"));
		expect(cp.lifecycle).toBe("awaiting_review");
		expect(cp.artifactBinding).toBeUndefined();
		expect(cp.verificationBindingIssue).toContain("api.txt");
	} finally {
		await ws.cleanup();
	}
});

test("copy limits and incomplete declarations are cannot-measure without running a fallback command", async () => {
	const ws = await makeTempWorkbench();
	try {
		await writeFile(join(ws.projectDir, "api.txt"), "x".repeat(20_000_001));
		await writeFile(join(ws.projectDir, "consumer.txt"), "v1");
		await writeFile(join(ws.projectDir, "check.cjs"), "process.exit(0)");
		const verification = {
			strategy: "test" as const,
			evidence: {
				report: {
					format: "vitest-json" as const,
					path: "report.json",
					expectedTests: ["contract"],
				},
				inputs: [],
				fixedFiles: {
					mode: "node-offline-files-v1" as const,
					script: "check.cjs",
					complete: true as const,
				},
			},
		};
		const options = {
			artifact: {
				path: "consumer.txt",
				inputs: ["api.txt"],
				source: "declared" as const,
			},
			recordDir: join(ws.workbenchRoot, "checkpoints", "objects"),
		};
		const oversized = await runVerification(
			verification,
			ws.projectDir,
			10,
			options,
		);
		expect(oversized.status).toBe("needs_human");
		if (oversized.status === "needs_human")
			expect(oversized.reason).toContain("20 MB");
		const arbitrary = await runVerification(
			{ ...verification, command: "node check.cjs" },
			ws.projectDir,
			10,
			options,
		);
		expect(arbitrary.status).toBe("needs_human");
		const missingArtifact = await runVerification(
			verification,
			ws.projectDir,
			10,
			{ recordDir: options.recordDir },
		);
		expect(missingArtifact.status).toBe("needs_human");
	} finally {
		await ws.cleanup();
	}
});
