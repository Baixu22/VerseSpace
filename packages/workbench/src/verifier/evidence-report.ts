import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { hashText } from "../hash";
import type {
	VerificationEvidence,
	VerificationEvidenceSpec,
} from "../types/verification-evidence";

export async function evidenceFilePath(
	cwd: string,
	path: string,
): Promise<string> {
	const root = await realpath(cwd);
	const file = await realpath(resolve(root, path));
	const rel = relative(root, file);
	if (
		!rel ||
		rel === ".." ||
		rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
		isAbsolute(rel)
	)
		throw new Error("证据文件不在执行目录内");
	return file;
}

/** A report must be produced again by this run, even when its content repeats. */
export async function reportStamp(
	cwd: string,
	path: string,
): Promise<string | null> {
	try {
		const file = await evidenceFilePath(cwd, path);
		const info = await stat(file, { bigint: true });
		return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
	} catch {
		return null;
	}
}

const count = z.number().int().nonnegative();
const reportSchema = z.object({
	numTotalTests: count,
	numPassedTests: count,
	numFailedTests: count,
	numPendingTests: count,
	numTodoTests: count.optional(),
	success: z.boolean(),
	testResults: z.array(
		z.object({
			assertionResults: z.array(
				z.object({
					fullName: z.string().min(1),
					status: z.enum([
						"passed",
						"failed",
						"pending",
						"skipped",
						"todo",
						"disabled",
					]),
				}),
			),
		}),
	),
});

export async function collectVerificationEvidence(
	cwd: string,
	spec: VerificationEvidenceSpec,
	previousStamp: string | null,
): Promise<VerificationEvidence> {
	const evidence: VerificationEvidence = {
		status: "unknown",
		source: "vitest-json",
		reportPath: spec.report.path,
		expectedTests: [...spec.report.expectedTests],
		actualTests: [],
		counts: { total: 0, passed: 0, failed: 0, skipped: 0 },
		reason: "报告不可读取",
	};
	try {
		const stamp = await reportStamp(cwd, spec.report.path);
		if (!stamp || stamp === previousStamp)
			throw new Error("报告缺失或本次未更新");
		const path = await evidenceFilePath(cwd, spec.report.path);
		if ((await stat(path)).size > 10_000_000)
			throw new Error("报告超过 10 MB 上限");
		const content = await readFile(path, "utf8");
		evidence.reportHash = hashText(content);
		const report = reportSchema.parse(JSON.parse(content));
		if (stamp !== (await reportStamp(cwd, spec.report.path)))
			throw new Error("读取期间报告变化");
		evidence.actualTests = report.testResults.flatMap((suite) =>
			suite.assertionResults.map((test) => ({
				name: test.fullName,
				status: test.status,
			})),
		);
		const tests = evidence.actualTests;
		evidence.counts = {
			total: tests.length,
			passed: tests.filter((t) => t.status === "passed").length,
			failed: tests.filter((t) => t.status === "failed").length,
			skipped: tests.filter(
				(t) => t.status !== "passed" && t.status !== "failed",
			).length,
		};
		const counts = evidence.counts;
		if (
			report.numTotalTests !== counts.total ||
			report.numPassedTests !== counts.passed ||
			report.numFailedTests !== counts.failed ||
			report.numPendingTests + (report.numTodoTests ?? 0) !== counts.skipped
		)
			throw new Error("报告计数与实际用例不一致");
		const expected = new Set(spec.report.expectedTests);
		const names = new Set(tests.map((t) => t.name));
		const complete =
			expected.size > 0 &&
			names.size === tests.length &&
			names.size === expected.size &&
			[...expected].every((name) => names.has(name));
		evidence.status =
			complete && report.success && counts.passed === counts.total
				? "satisfied"
				: "unsatisfied";
		evidence.reason =
			evidence.status === "satisfied"
				? "声明用例集合全部通过"
				: "实际用例集合不等于声明范围，或存在失败/跳过";
	} catch (error) {
		evidence.status = "unknown";
		evidence.reason =
			error instanceof SyntaxError || error instanceof z.ZodError
				? "报告格式损坏或不受支持"
				: String(error);
	}
	return evidence;
}
