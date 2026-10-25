import { writeFile } from "node:fs/promises";
import type { Command } from "commander";
import { exportArtifactManifest } from "../artifacts/manifest";
import {
	assessArtifactManifest,
	stableManifestJson,
} from "../artifacts/manifest-codec";
import { emitJson, type GlobalOptions } from "../output";
import { resolveBlackboard } from "./context";

export async function checkpointExport(
	id: string,
	options: { output?: string },
	command: Command,
) {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const manifest = await exportArtifactManifest(await resolveBlackboard(), id);
	const assessment = assessArtifactManifest(manifest);
	if (options.output)
		await writeFile(options.output, `${stableManifestJson(manifest)}\n`, {
			flag: "wx",
		});
	if (opts.json) emitJson({ manifest, assessment });
	else if (!opts.quiet)
		console.log(
			options.output
				? `已导出 ${manifest.digest}；${assessment.status}`
				: stableManifestJson(manifest),
		);
}
