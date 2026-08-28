// Single-target binary build used by release-workbench.yml: one host per
// matrix job builds only its own target (no cross-compile downloads needed).
// Usage: bun run scripts/build-single.ts <bun-target> <artifact-name>

import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [bunTarget, artifactName] = process.argv.slice(2);
if (!bunTarget || !artifactName) {
	console.error(
		"usage: bun run scripts/build-single.ts <bun-target> <artifact-name>",
	);
	process.exit(2);
}

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(PKG_ROOT, "dist");

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

const result = await Bun.build({
	entrypoints: [join(PKG_ROOT, "src/index.ts")],
	compile: {
		target: bunTarget as
			| "bun-darwin-x64"
			| "bun-darwin-arm64"
			| "bun-windows-x64"
			| "bun-linux-x64",
		outfile: join(DIST, artifactName),
	},
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}
console.log(`compiled → ${join("dist", artifactName)}`);
