import { expect, test } from "bun:test";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashText } from "../hash";
import { makeTempWorkbench } from "../test/fixtures";
import { verificationObjectSchema } from "../types/verification-evidence";
import {
	fixedObjectCurrentIssue,
	fixedObjectReportIssue,
} from "./fixed-object";
import { runVerification } from "./index";

const CHECK = `const fs=require('node:fs');
const api=fs.readFileSync('api.txt','utf8');
const consumer=fs.readFileSync('consumer.txt','utf8');
const ok=api===consumer;
fs.writeFileSync('report.json',JSON.stringify({numTotalTests:1,numPassedTests:+ok,numFailedTests:+!ok,numPendingTests:0,success:ok,testResults:[{assertionResults:[{fullName:'contract',status:ok?'passed':'failed'}]}]}));
process.exitCode=ok?0:1;`;
function verification() {
	return {
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
}

async function waitForCopy(recordDir: string): Promise<string> {
	const deadline = Date.now() + 8000;
	while (Date.now() < deadline) {
		for (const name of await readdir(recordDir).catch(() => [])) {
			const copy = join(recordDir, name, "files");
			// Plan is written after all copied bytes, before the child is spawned.
			if (
				await stat(join(copy, ".workbench-fixed-plan.json")).catch(() => null)
			)
				return copy;
		}
		await Bun.sleep(10);
	}
	throw new Error("fixed copy did not become ready");
}

test("real Node offline copy records executed bytes, runner and report without exposing source output", async () => {
	const ws = await makeTempWorkbench();
	try {
		await writeFile(join(ws.projectDir, "api.txt"), "v1");
		await writeFile(join(ws.projectDir, "consumer.txt"), "v1");
		await writeFile(join(ws.projectDir, "check.cjs"), CHECK);
		const recordDir = join(ws.workbenchRoot, "checkpoints", "objects");
		const result = await runVerification(verification(), ws.projectDir, 10, {
			artifact: {
				path: "consumer.txt",
				inputs: ["api.txt"],
				source: "declared",
			},
			recordDir,
		});
		expect(result.status, JSON.stringify(result)).toBe("passed");
		expect(result.evidence?.status).toBe("satisfied");
		expect(verificationObjectSchema.safeParse(result.object).success).toBe(
			true,
		);
		const object = result.object!;
		expect(object.files.find((file) => file.path === "api.txt")?.hash).toBe(
			hashText("v1"),
		);
		expect(object.runner.version).toMatch(/^v24\./);
		expect(object.reportHash).toBe(result.evidence!.reportHash);
		expect(await fixedObjectCurrentIssue(object, ws.projectDir)).toBeNull();
		expect(await fixedObjectReportIssue(object, recordDir)).toBeNull();
		expect(await stat(object.executedCwd).catch(() => null)).toBeNull();
		expect(
			await stat(join(ws.projectDir, "report.json")).catch(() => null),
		).toBeNull();
		const report = JSON.parse(
			await readFile(join(recordDir, object.reportFile!), "utf8"),
		);
		expect(report.numPassedTests).toBe(1);
	} finally {
		await ws.cleanup();
	}
});

test.each([
	false,
	true,
])("source write during a real fixed-file check preserves copied v1 (ABA=%s)", async (aba) => {
	const ws = await makeTempWorkbench();
	try {
		await writeFile(join(ws.projectDir, "api.txt"), "v1");
		await writeFile(join(ws.projectDir, "consumer.txt"), "v1");
		await writeFile(
			join(ws.projectDir, "check.cjs"),
			`setTimeout(()=>{${CHECK}},500);`,
		);
		const recordDir = join(ws.workbenchRoot, "checkpoints", "objects");
		const pending = runVerification(verification(), ws.projectDir, 10, {
			artifact: {
				path: "consumer.txt",
				inputs: ["api.txt"],
				source: "declared",
			},
			recordDir,
		});
		await waitForCopy(recordDir);
		await writeFile(join(ws.projectDir, "api.txt"), "v2");
		if (aba) {
			await Bun.sleep(70);
			await writeFile(join(ws.projectDir, "api.txt"), "v1");
		}
		const result = await pending;
		expect(result.status, JSON.stringify(result)).toBe("passed");
		expect(
			result.object?.files.find((file) => file.path === "api.txt")?.hash,
		).toBe(hashText("v1"));
		const issue = await fixedObjectCurrentIssue(result.object!, ws.projectDir);
		if (aba) expect(issue).toBeNull();
		else expect(issue).toContain("api.txt");
	} finally {
		await ws.cleanup();
	}
});

test.each([
	"require('./missing.cjs');",
	"require('node:fs').readFileSync('missing.txt');",
	"require('node:http');",
	"require('node:child_process');",
	"require('node:fs').writeFileSync('api.txt','modified');",
])("undeclared state is cannot-measure without a live-workspace fallback: %s", async (script) => {
	const ws = await makeTempWorkbench();
	try {
		await writeFile(join(ws.projectDir, "api.txt"), "v1");
		await writeFile(join(ws.projectDir, "consumer.txt"), "v1");
		await writeFile(join(ws.projectDir, "check.cjs"), script);
		await writeFile(
			join(ws.projectDir, "missing.txt"),
			"exists only in source",
		);
		await writeFile(join(ws.projectDir, "missing.cjs"), "module.exports=1;");
		const result = await runVerification(verification(), ws.projectDir, 10, {
			artifact: {
				path: "consumer.txt",
				inputs: ["api.txt"],
				source: "declared",
			},
			recordDir: join(ws.workbenchRoot, "checkpoints", "objects"),
		});
		expect(result.status, JSON.stringify(result)).toBe("needs_human");
		if (result.status === "needs_human")
			expect(result.reason).toContain("不能测量");
		expect(await readFile(join(ws.projectDir, "api.txt"), "utf8")).toBe("v1");
	} finally {
		await ws.cleanup();
	}
});
