import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type CodeRef, extractRefs } from "./extract";
import {
	buildFileIndex,
	checkIgnored,
	type FileIndex,
	isInstructionFile,
} from "./file-index";
import {
	buildCorpus,
	type VerifyResult,
	verifyRef,
	verifySymbols,
} from "./verify";

export interface StaleRef extends CodeRef {
	reason: string;
}

export interface ScanFinding extends CodeRef {
	status: VerifyResult["status"] | "generated";
	reason?: string;
}

export interface ScanResult {
	root: string;
	docs: string[];
	total: number;
	valid: number;
	stale: StaleRef[];
	generated: number;
	unverified: number;
	durationMs: number;
	findings: ScanFinding[];
}

/** Both CLIs discover and verify paths here; the standalone CLI also checks symbols/packages. */
export function collectDocFiles(
	root: string,
	index: FileIndex = buildFileIndex(root),
): string[] {
	return [...index.files].filter(isInstructionFile).sort();
}

export async function scanRepo(
	rootInput: string,
	options: { pathsOnly?: boolean } = {},
): Promise<ScanResult> {
	const started = performance.now();
	const root = resolve(rootInput);
	const index = buildFileIndex(root);
	const docs = collectDocFiles(root, index);
	const refs = docs
		.flatMap((doc) => extractRefs(doc, readFileSync(join(root, doc), "utf8")))
		.filter((ref) => !options.pathsOnly || ref.kind === "path");
	const corpus = options.pathsOnly
		? {
				entries: [],
				sourceFiles: [],
				packageJsonFiles: [],
				docFiles: new Set<string>(),
			}
		: buildCorpus(root, docs);
	const findings: ScanFinding[] = [];
	const symbolRefs: CodeRef[] = [];
	for (const ref of refs) {
		if (ref.kind === "symbol") symbolRefs.push(ref);
		else findings.push({ ...ref, ...verifyRef(ref, root, corpus, index) });
	}
	const symbolResults = await verifySymbols(symbolRefs, corpus);
	symbolRefs.forEach((ref, i) => {
		findings.push({ ...ref, ...symbolResults[i]! });
	});

	const ignored = checkIgnored(
		root,
		findings
			.filter((ref) => ref.kind === "path" && ref.status !== "valid")
			.map((ref) => ref.text),
	);
	for (const finding of findings) {
		if (
			finding.kind === "path" &&
			finding.status !== "valid" &&
			ignored.has(finding.text)
		) {
			finding.status = "generated";
			delete finding.reason;
		}
	}
	findings.sort((a, b) => a.doc.localeCompare(b.doc) || a.line - b.line);
	return {
		root,
		docs,
		total: findings.length,
		valid: findings.filter((ref) => ref.status === "valid").length,
		stale: findings
			.filter((ref) => ref.status === "stale")
			.map((ref) => ({ ...ref, reason: ref.reason ?? "未知原因" })),
		generated: findings.filter((ref) => ref.status === "generated").length,
		unverified: findings.filter((ref) => ref.status === "unverified").length,
		durationMs: Math.round(performance.now() - started),
		findings,
	};
}
