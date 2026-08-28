import type { Command } from "commander";
import type { DriftReport } from "../blackboard/interfaces";
import { hashFile } from "../hash";
import { emitJson, type GlobalOptions } from "../output";
import { resolveBlackboard } from "./context";

export async function interfaceRegister(
	path: string,
	options: { key?: string },
	command: Command,
): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	if (!options.key) {
		throw new Error("interface register 需要 --key 命名该接口");
	}
	const bb = await resolveBlackboard();
	if (await bb.interfaces.getEntry(options.key)) {
		throw new Error(
			`接口 ${options.key} 已注册，如需重锚定请用 workbench interface check`,
		);
	}
	const entry = await bb.interfaces.register({
		key: options.key,
		canonicalPath: path,
		version: 1,
		publishedBy: "human",
		lastModified: new Date().toISOString(),
		contentHash: await hashFile(`${bb.projectRoot}/${path}`),
		subscribers: [],
	});
	if (opts.json) {
		emitJson(entry);
	} else if (!opts.quiet) {
		console.log(`已注册接口 ${entry.key} → ${entry.canonicalPath}（v1）`);
	}
}

export async function interfaceList(command: Command): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const bb = await resolveBlackboard();
	const entries = await bb.interfaces.list();
	if (opts.json) {
		emitJson(entries);
	} else if (!opts.quiet) {
		if (entries.length === 0) {
			console.log(
				"（还没有注册接口，用 workbench interface register <path> --key <key>）",
			);
		}
		for (const entry of entries) {
			console.log(
				`${entry.key.padEnd(24)} v${entry.version}  ${entry.canonicalPath}`,
			);
		}
	}
}

export async function interfaceCheck(command: Command): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const bb = await resolveBlackboard();
	const entries = await bb.interfaces.list();
	const reports: DriftReport[] = [];
	for (const entry of entries) {
		reports.push(await bb.interfaces.checkDrift(entry.key));
	}
	if (opts.json) {
		emitJson(reports);
	} else if (!opts.quiet) {
		if (reports.length === 0) {
			console.log("（没有注册接口）");
		}
		for (const report of reports) {
			const state = report.missing
				? "缺失"
				: report.drifted
					? "已漂移"
					: "一致";
			console.log(`${report.key.padEnd(24)} ${state}`);
		}
	}
	if (reports.some((report) => report.drifted)) {
		process.exitCode = 1;
	}
}
