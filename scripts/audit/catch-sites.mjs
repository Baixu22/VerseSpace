#!/usr/bin/env node
/**
 * Catch-site inventory (deposited 2026-09-26, TF-0275).
 *
 * The 2026-09-25 audit (docs/handoff/2026-09-25-catch-after-continue-audit.md)
 * reported "140 catch sites across 61 files" from a script that lived only in
 * `.agent-contexts/` on the maintainer's disk. A number nobody else can recompute
 * is not evidence — this is that script, in the repo.
 *
 * Counting rule, same as the audit: a line matching `catch (` or `catch {` in a
 * non-test `.ts` file under packages/workbench/src. Lines that are themselves
 * doc-comment text are NOT sites (the audit counted 5 of those separately) — a
 * comment that mentions the pattern is not a place where an error is swallowed.
 *
 * Usage: node scripts/audit/catch-sites.mjs [--json]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = join(REPO, "packages", "workbench", "src");
const CATCH = /\bcatch\s*(\(|\{)/;

function walk(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) walk(path, out);
		else if (path.endsWith(".ts")) out.push(path);
	}
	return out;
}

const perFile = [];
let sites = 0;
let commentMentions = 0;
for (const file of walk(ROOT).sort()) {
	const rel = relative(ROOT, file).replace(/\\/g, "/");
	if (rel.endsWith(".test.ts")) continue;
	const lines = readFileSync(file, "utf8").split("\n");
	const found = [];
	lines.forEach((line, index) => {
		if (!CATCH.test(line)) return;
		const trimmed = line.trim();
		if (
			trimmed.startsWith("*") ||
			trimmed.startsWith("//") ||
			trimmed.startsWith("/*")
		) {
			commentMentions++;
			return;
		}
		found.push(index + 1);
	});
	if (found.length === 0) continue;
	sites += found.length;
	perFile.push({ file: rel, lines: found });
}

const report = {
	root: "packages/workbench/src",
	files: perFile.length,
	sites,
	commentMentions,
	perFile,
};

if (process.argv.includes("--json")) {
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
	console.log(
		`catch 站点：${sites} 个，分布在 ${perFile.length} 个文件（另有 ${commentMentions} 处只是注释里提到这个模式）`,
	);
	for (const entry of perFile) {
		console.log(
			`  ${String(entry.lines.length).padStart(3)}  ${entry.file}  ${entry.lines.join(",")}`,
		);
	}
}
