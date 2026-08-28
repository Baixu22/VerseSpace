// Workbench bundler: compiled Bun binaries for release + an npm-facing JS
// bundle. `bun run build` builds the host binary; `bun run build --all`
// cross-compiles every release target (Windows/macOS/Linux).
//
// Build outputs (git-ignored):
//   dist/workbench-<platform>-<arch>[.exe]  — single-file binaries
//   dist/workbench.js                       — bun-runtime JS bundle (npm bin)

import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(PKG_ROOT, "dist");

interface Target {
	label: string;
	bunTarget?: BunCompileTarget;
	outfile: string;
}

type BunCompileTarget =
	| "bun-darwin-x64"
	| "bun-darwin-arm64"
	| "bun-windows-x64"
	| "bun-linux-x64";

const RELEASE_TARGETS: Target[] = [
	{
		label: "windows-x64",
		bunTarget: "bun-windows-x64",
		outfile: "workbench-windows-x64.exe",
	},
	{
		label: "linux-x64",
		bunTarget: "bun-linux-x64",
		outfile: "workbench-linux-x64",
	},
	{
		label: "macos-arm64",
		bunTarget: "bun-darwin-arm64",
		outfile: "workbench-macos-arm64",
	},
	{
		label: "macos-x64",
		bunTarget: "bun-darwin-x64",
		outfile: "workbench-macos-x64",
	},
];

function hostBunTarget(): BunCompileTarget {
	if (process.platform === "darwin") {
		return process.arch === "arm64" ? "bun-darwin-arm64" : "bun-darwin-x64";
	}
	if (process.platform === "linux") {
		return "bun-linux-x64";
	}
	return "bun-windows-x64";
}

const HOST_TARGET: Target = {
	label: `host-${process.platform}-${process.arch}`,
	bunTarget: hostBunTarget(),
	outfile: process.platform === "win32" ? "workbench.exe" : "workbench",
};

const buildAll = process.argv.includes("--all");
const targets = buildAll ? RELEASE_TARGETS : [HOST_TARGET];

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

for (const target of targets) {
	const result = await Bun.build({
		entrypoints: [join(PKG_ROOT, "src/index.ts")],
		compile: {
			target: target.bunTarget ?? hostBunTarget(),
			outfile: join(DIST, target.outfile),
		},
	});
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		process.exit(1);
	}
	console.log(`compiled [${target.label}] → ${join("dist", target.outfile)}`);
}

// npm form: a single-file ESM bundle that `bun`/`bunx` can execute directly
// (the binary form above covers users without Bun).
const npmBundle = await Bun.build({
	entrypoints: [join(PKG_ROOT, "src/index.ts")],
	target: "bun",
	format: "esm",
	outdir: DIST,
	naming: { entry: "workbench.[ext]" },
});
if (!npmBundle.success) {
	for (const log of npmBundle.logs) console.error(log);
	process.exit(1);
}
console.log("compiled [npm] → dist/workbench.js");
