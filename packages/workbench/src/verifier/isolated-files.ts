import { createHash, randomUUID } from "node:crypto";
import {
	mkdir,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { hashFile, hashText } from "../hash";
import { fixedNodeRunner, runnerEnvironment } from "./fixed-node";

export { fixedNodeRunner } from "./fixed-node";

import type { ArtifactDeclaration } from "../types/artifact-evidence";
import type { VerificationStrategy } from "../types/goal";
import type { VerificationObject } from "../types/verification-evidence";
import {
	collectVerificationEvidence,
	evidenceFilePath,
} from "./evidence-report";
import { executeVerification } from "./execute";
import { FIXED_RUNNER } from "./fixed-runner";
import type { VerifyResult } from "./index";

const MAX_COPY_BYTES = 20_000_000;
const MAX_FILES = 128;
const LIMITATIONS =
	"Trusted declared offline files; no hostile-code sandbox or atomic source snapshot" as const;

function fileName(path: string): string {
	const name = path.replace(/\\/g, "/").replace(/^\.\//, "");
	if (
		!name ||
		isAbsolute(name) ||
		/[\0\r\n*?<>|:,]/.test(name) ||
		name
			.split("/")
			.some(
				(part) =>
					part === ".." ||
					part === ".workbench" ||
					part.startsWith(".workbench-fixed-"),
			)
	)
		throw new Error("固定副本路径不受支持");
	return name;
}

export interface FixedFileOptions {
	artifact?: ArtifactDeclaration;
	recordDir?: string;
}

export function declaredFixedFiles(
	verification: VerificationStrategy,
	artifact: ArtifactDeclaration,
): string[] {
	const spec = verification.evidence;
	if (!spec?.fixedFiles) throw new Error("缺少固定文件模式声明");
	return [
		...new Set(
			[
				spec.fixedFiles.script,
				artifact.path,
				...artifact.inputs,
				...spec.inputs,
			].map(fileName),
		),
	].sort();
}

export function verificationObjectDigest(
	object: Pick<
		VerificationObject,
		"mode" | "files" | "runner" | "script" | "reportPath" | "bootstrapHash"
	>,
): string {
	return hashText(
		JSON.stringify({
			mode: object.mode,
			files: object.files,
			runner: object.runner,
			script: object.script,
			report: object.reportPath,
			bootstrapHash: object.bootstrapHash,
		}),
	);
}

/** Copy only the explicit closure, execute it once, and keep only its report and hashes. */
export async function runIsolatedFiles(
	verification: VerificationStrategy,
	cwd: string,
	timeoutSeconds: number,
	options: FixedFileOptions,
): Promise<VerifyResult> {
	const spec = verification.evidence;
	const fixed = spec?.fixedFiles;
	let copyDir: string | undefined;
	try {
		if (
			!fixed ||
			!spec ||
			!options.artifact ||
			!options.recordDir ||
			verification.command ||
			verification.strategy === "human-review"
		)
			throw new Error(
				"固定副本要求单产物、完整离线脚本声明和报告目录，不能附带任意 command",
			);
		const node = await fixedNodeRunner(cwd);
		const sourceCwd = await realpath(cwd);
		const names = declaredFixedFiles(verification, options.artifact);
		const report = fileName(spec.report.path);
		if (names.length > MAX_FILES || names.includes(report))
			throw new Error("固定副本文件数超预算，或报告与输入重叠");
		const root = await realpath(
			await mkdir(options.recordDir, { recursive: true }).then(
				() => options.recordDir!,
			),
		);
		const objectId = `fixed-${randomUUID()}`;
		const objectDir = join(root, objectId);
		copyDir = join(objectDir, "files");
		await mkdir(copyDir, { recursive: true });
		const started = performance.now();
		const files: VerificationObject["files"] = [];
		let copyBytes = 0;
		for (const path of names) {
			const input = await evidenceFilePath(sourceCwd, path);
			const before = await stat(input);
			if (!before.isFile() || copyBytes + before.size > MAX_COPY_BYTES)
				throw new Error("固定副本输入不是文件或复制超过 20 MB");
			const bytes = await readFile(input);
			const after = await stat(input);
			copyBytes += bytes.length;
			if (
				copyBytes > MAX_COPY_BYTES ||
				before.size !== bytes.length ||
				after.size !== bytes.length ||
				before.mtimeMs !== after.mtimeMs ||
				before.ctimeMs !== after.ctimeMs
			)
				throw new Error("复制期间输入变化或超过预算，不能声明固定执行对象");
			const output = join(copyDir, path);
			await mkdir(dirname(output), { recursive: true });
			await writeFile(output, bytes, { flag: "wx" });
			files.push({
				path,
				hash: createHash("sha256").update(bytes).digest("hex"),
				bytes: bytes.length,
			});
		}
		const runner = node.runner;
		const bootstrap = join(copyDir, ".workbench-fixed-runner.mjs");
		const plan = join(copyDir, ".workbench-fixed-plan.json");
		await writeFile(bootstrap, FIXED_RUNNER);
		await writeFile(
			plan,
			JSON.stringify({ script: fileName(fixed.script), files: names }),
		);
		await mkdir(dirname(join(copyDir, report)), { recursive: true });
		const object: VerificationObject = {
			schemaVersion: 1,
			mode: fixed.mode,
			sourceCwd,
			executedCwd: copyDir,
			files,
			runner,
			script: fileName(fixed.script),
			reportPath: report,
			bootstrapHash: hashText(FIXED_RUNNER),
			manifestHash: "",
			copyBytes,
			copyMs: performance.now() - started,
			runMs: 0,
			limitations: LIMITATIONS,
		};
		object.manifestHash = verificationObjectDigest(object);
		const args = [
			node.file,
			"--permission",
			"--disallow-code-generation-from-strings",
			...[bootstrap, plan, ...names.map((path) => join(copyDir!, path))].map(
				(path) => `--allow-fs-read=${path}`,
			),
			`--allow-fs-write=${join(copyDir, report)}`,
			bootstrap,
		];
		const runStarted = performance.now();
		const execution = await executeVerification(
			args,
			copyDir,
			Math.min(timeoutSeconds, 60),
			runnerEnvironment(),
		);
		object.runMs = performance.now() - runStarted;
		const evidence = await collectVerificationEvidence(copyDir, spec, null);
		if (evidence.reportHash) {
			const reportBytes = await readFile(
				await evidenceFilePath(copyDir, report),
			);
			if (
				reportBytes.length > 10_000_000 ||
				createHash("sha256").update(reportBytes).digest("hex") !==
					evidence.reportHash
			)
				throw new Error("副本报告读取期间变化或超预算");
			await writeFile(join(objectDir, "report.json"), reportBytes, {
				flag: "wx",
			});
			object.reportFile = `${objectId}/report.json`;
			object.reportHash = evidence.reportHash;
		}
		for (const file of files)
			if ((await hashFile(join(copyDir, file.path))) !== file.hash)
				throw new Error("检查修改了固定副本输入");
		if (execution.timedOut)
			return {
				status: "timeout",
				exitCode: execution.exitCode,
				evidence,
				object,
			};
		if (
			/WORKBENCH_FIXED_INPUT_GAP:|ERR_ACCESS_DENIED|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/.test(
				execution.output,
			)
		)
			return {
				status: "needs_human",
				reason: "固定副本不能测量：检查访问了未声明模块或文件",
				exitCode: execution.exitCode,
				evidence,
				object,
			};
		return execution.exitCode === (verification.expectedExitCode ?? 0)
			? { status: "passed", exitCode: execution.exitCode, evidence, object }
			: {
					status: "failed",
					output: execution.output.slice(-20_000),
					exitCode: execution.exitCode,
					evidence,
					object,
				};
	} catch (error) {
		return {
			status: "needs_human",
			reason: `固定副本不能测量：${String(error instanceof Error ? error.message : error)}`,
		};
	} finally {
		if (copyDir) {
			const parent = resolve(options.recordDir!);
			const path = resolve(copyDir);
			const rel = relative(parent, path);
			if (rel && !rel.startsWith("..") && !isAbsolute(rel))
				await rm(path, {
					recursive: true,
					force: true,
					maxRetries: 5,
					retryDelay: 100,
				}).catch((error) =>
					console.warn(
						`[verify] 固定副本清理失败，仍保留 ${path}: ${String(error)}`,
					),
				);
		}
	}
}
