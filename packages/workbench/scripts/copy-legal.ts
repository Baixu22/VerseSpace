// Ship the attribution files with every distribution.
//
// Apache-2.0 §4(d) requires a readable copy of NOTICE to accompany any
// redistribution, and this product compiles Apache-2.0 code (the dashboard
// theme subset) into the binary. `dist/` is what gets archived, uploaded and
// attached to a release, so the files have to land there — not only in the
// package root. See NOTICE for the exact scope of the Apache-2.0 portions.

import { copyFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Legal files that must appear next to the built artifacts. */
export const LEGAL_FILES = ["NOTICE", "LICENSE", "LICENSE-APACHE"] as const;

export async function copyLegalFiles(distDir: string): Promise<string[]> {
	for (const name of LEGAL_FILES) {
		await copyFile(join(PKG_ROOT, name), join(distDir, name));
	}
	return [...LEGAL_FILES];
}
