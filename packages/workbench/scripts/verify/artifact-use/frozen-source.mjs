/** Materialize the old source for repeatable comparisons after main advances. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const baselineSha = "a7197bacd7159e704278a0dd5cf2233952d4e0fe";
export function frozenSource() {
	const root = fileURLToPath(new URL("../../../../../", import.meta.url));
	const cwd = mkdtempSync(join(tmpdir(), "artifact-old-source-"));
	const archive = join(cwd, "source.tar");
	execFileSync(
		"git",
		[
			"archive",
			"--format=tar",
			"--output",
			archive,
			baselineSha,
			"packages/workbench/src",
			"packages/context-rot/src",
		],
		{ cwd: root, stdio: "pipe", windowsHide: true },
	);
	execFileSync("tar", ["-xf", archive, "-C", cwd], {
		stdio: "pipe",
		windowsHide: true,
	});
	symlinkSync(
		join(root, "node_modules"),
		join(cwd, "node_modules"),
		process.platform === "win32" ? "junction" : "dir",
	);
	return cwd;
}
