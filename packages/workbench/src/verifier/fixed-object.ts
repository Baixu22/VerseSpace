import { realpath, stat } from "node:fs/promises";
import { hashFile, hashText } from "../hash";
import type { ArtifactDeclaration } from "../types/artifact-evidence";
import type { VerificationStrategy } from "../types/goal";
import type { VerificationObject } from "../types/verification-evidence";
import { evidenceFilePath } from "./evidence-report";
import { FIXED_RUNNER } from "./fixed-runner";
import { declaredFixedFiles, verificationObjectDigest } from "./isolated-files";

/** Copied file identities, not endpoint hashes alone, define the verified object. */
export async function fixedObjectCurrentIssue(
	object: VerificationObject,
	cwd: string,
	declaration?: {
		verification: VerificationStrategy;
		artifact: ArtifactDeclaration;
	},
): Promise<string | null> {
	try {
		if (
			object.manifestHash !== verificationObjectDigest(object) ||
			object.bootstrapHash !== hashText(FIXED_RUNNER)
		)
			return "固定副本执行清单或运行器已变化";
		if (declaration) {
			const names = declaredFixedFiles(
				declaration.verification,
				declaration.artifact,
			);
			if (
				JSON.stringify(names) !==
					JSON.stringify(object.files.map((file) => file.path)) ||
				object.script !==
					declaration.verification.evidence?.fixedFiles?.script
						.replace(/\\/g, "/")
						.replace(/^\.\//, "") ||
				object.reportPath !==
					declaration.verification.evidence?.report.path
						.replace(/\\/g, "/")
						.replace(/^\.\//, "")
			)
				return "固定副本清单与声明文件集合不一致";
		}
		if ((await realpath(cwd)) !== object.sourceCwd)
			return "固定副本的源工位身份已变化";
		if (
			new Set(object.files.map((file) => file.path)).size !==
				object.files.length ||
			!object.files.some((file) => file.path === object.script)
		)
			return "固定副本清单缺脚本或重复文件";
		for (const file of object.files) {
			const path = await evidenceFilePath(cwd, file.path);
			if (
				(await stat(path)).size !== file.bytes ||
				(await hashFile(path)) !== file.hash
			)
				return `固定副本结果不适用于当前文件 ${file.path}`;
		}
		return null;
	} catch {
		return "固定副本源文件不可完整读取";
	}
}

export async function fixedObjectReportIssue(
	object: VerificationObject,
	recordDir: string,
): Promise<string | null> {
	try {
		if (!object.reportFile || !object.reportHash)
			return "固定副本缺少归档报告摘要";
		const file = await evidenceFilePath(recordDir, object.reportFile);
		if (
			(await stat(file)).size > 10_000_000 ||
			(await hashFile(file)) !== object.reportHash
		)
			return "固定副本归档报告摘要不一致";
		return null;
	} catch {
		return "固定副本归档报告不可读取";
	}
}
