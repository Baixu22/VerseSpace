import { scanRepo } from "../../../context-rot/src/scan";
import { findGitRoot } from "../paths";

export {
	type FileIndex,
	isInstructionFile,
	resolveRef,
} from "../../../context-rot/src/file-index";

export interface RotFinding {
	ref: string;
	kind: "path" | "file";
	stale: boolean;
	generated: boolean;
	source: string;
	line: number;
}

export interface RotReport {
	assertions: number;
	stale: number;
	generated: number;
	sources: string[];
	findings: RotFinding[];
}

/** The doctor preserves its unique-path report over the shared context-rot scanner. */
export async function runContextRot(startDir: string): Promise<RotReport> {
	const root = (await findGitRoot(startDir)) ?? startDir;
	const scan = await scanRepo(root, { pathsOnly: true });
	const first = new Map<string, RotFinding>();
	for (const finding of scan.findings) {
		if (first.has(finding.text)) continue;
		first.set(finding.text, {
			ref: finding.text,
			kind: finding.text.includes("/") ? "path" : "file",
			stale: finding.status === "stale",
			generated: finding.status === "generated",
			source: finding.doc,
			line: finding.line,
		});
	}
	const findings = [...first.values()].sort(
		(a, b) =>
			Number(b.stale) - Number(a.stale) ||
			a.source.localeCompare(b.source) ||
			a.line - b.line,
	);
	return {
		assertions: findings.length,
		stale: findings.filter((finding) => finding.stale).length,
		generated: findings.filter((finding) => finding.generated).length,
		sources: scan.docs,
		findings,
	};
}

export function formatRotHeadline(report: RotReport): string {
	if (report.assertions === 0) {
		return "context rot：指令文件里没有可核对的代码路径引用（CLAUDE.md / AGENTS.md / .cursorrules）";
	}
	const pct =
		report.stale === 0
			? "0%"
			: `${Math.round((report.stale / report.assertions) * 100)}%`;
	const generatedNote =
		report.generated > 0 ? `，另有 ${report.generated} 条生成物引用不计入` : "";
	return `context rot：${report.assertions} 条架构断言，${report.stale} 条已失效（${pct}）${generatedNote}`;
}
