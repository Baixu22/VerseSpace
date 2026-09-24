// Shared by build.ts / build-single.ts: builds apps/workbench-ui (Vite) and
// regenerates the embedded-asset manifest consumed by src/ui/server.ts.

import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { writeFileAtomic } from "../src/fs/atomic";

const PKG_ROOT = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(PKG_ROOT, "..", "..");
const UI_APP = join(REPO_ROOT, "apps", "workbench-ui");
const UI_DIST = join(UI_APP, "dist");
const MANIFEST = join(PKG_ROOT, "src", "ui", "assets.generated.js");

async function walk(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await walk(abs)));
		} else {
			files.push(abs);
		}
	}
	return files.sort();
}

/**
 * Build the dashboard and rewrite assets.generated.js with one
 * `with { type: "file" }` import per dist file — Bun compiles those into the
 * executable so the binary serves the UI standalone.
 */
export async function prepareUiAssets(): Promise<void> {
	if (process.env.WORKBENCH_SKIP_UI_BUILD === "1") {
		return;
	}
	const build = spawnSync("bun", ["run", "build"], {
		cwd: UI_APP,
		stdio: "inherit",
		shell: process.platform === "win32",
	});
	if (build.status !== 0) {
		throw new Error("workbench-ui build failed");
	}

	const distFiles = await walk(UI_DIST);
	// Specifiers are written RELATIVE to the manifest, never as machine-absolute
	// paths: the manifest is a tracked file, and an absolute specifier bakes the
	// generating machine's checkout path into it, so a fresh clone (or CI on a
	// different drive) would import files that do not exist. Bun resolves each
	// specifier against the importing module, so relative is equivalent at build
	// time and correct everywhere else.
	const manifestDir = dirname(MANIFEST);
	const imports: string[] = [];
	const map: string[] = ["export const files = {"];
	distFiles.forEach((abs, index) => {
		const key = relative(UI_DIST, abs).replace(/\\/g, "/");
		const spec = relative(manifestDir, abs).replace(/\\/g, "/");
		imports.push(`import a${index} from "${spec}" with { type: "file" };`);
		map.push(`\t"${key}": a${index},`);
	});
	map.push("};");
	await writeFileAtomic(MANIFEST, [...imports, ...map, ""].join("\n"));
	console.log(`ui assets: ${distFiles.length} files embedded`);
}

// Entry point so `bun run scripts/ui-prepare.ts` (used by the root `build:ui`
// script) actually does something. Imported from build.ts / build-single.ts it
// stays a plain module and this block does not run.
if (import.meta.main) {
	await prepareUiAssets();
}
