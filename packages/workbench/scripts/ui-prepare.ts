// Shared by build.ts / build-single.ts: builds apps/workbench-ui (Vite) and
// regenerates the embedded-asset manifest consumed by src/ui/server.ts.

import { spawnSync } from "node:child_process";
import { readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

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
	const imports: string[] = [];
	const map: string[] = ["export const files = {"];
	distFiles.forEach((abs, index) => {
		const key = relative(UI_DIST, abs).replace(/\\/g, "/");
		imports.push(
			`import a${index} from "${abs.replace(/\\/g, "/")}" with { type: "file" };`,
		);
		map.push(`\t"${key}": a${index},`);
	});
	map.push("};");
	await writeFile(MANIFEST, [...imports, ...map, ""].join("\n"), "utf8");
	console.log(`ui assets: ${distFiles.length} files embedded`);
}
