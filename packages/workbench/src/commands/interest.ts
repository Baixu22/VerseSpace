import type { Command } from "commander";
import { collectInterest, lowerInterest } from "../interactions/context";
import { emitJson, type GlobalOptions } from "../output";
import { resolveBlackboard } from "./context";

export function registerInterestCommands(program: Command): void {
	const context = program
		.command("context")
		.description("查看写者的上下文并降低过时条目的兴趣");
	context
		.command("list")
		.requiredOption("--writer <id>", "写者或线程 ID")
		.action(async (options: { writer: string }, command: Command) => {
			const view = await collectInterest(
				await resolveBlackboard(),
				options.writer,
			);
			const opts = command.optsWithGlobals() as GlobalOptions;
			if (opts.json) return emitJson(view);
			if (opts.quiet) return;
			console.log(
				`写者 ${view.writer} · 累计降低兴趣 ${view.reductions.total} 次`,
			);
			for (const landmark of view.landmarks)
				console.log(`${landmark.handle} · ${landmark.summary}`);
		});
	context
		.command("lower <handle>")
		.requiredOption("--writer <id>", "写者或线程 ID")
		.description("降低已观察条目的兴趣；再次阅读或编辑后自动恢复")
		.action(
			async (handle: string, options: { writer: string }, command: Command) => {
				const result = await lowerInterest(
					await resolveBlackboard(),
					options.writer,
					handle,
				);
				const opts = command.optsWithGlobals() as GlobalOptions;
				if (opts.json) return emitJson(result);
				if (!opts.quiet)
					console.log(
						`${result.handle}：${result.recorded ? "已降低兴趣" : "已在可见范围之外"}`,
					);
			},
		);
}
