import type { Command } from "commander";
import { collectInterest, lowerInterest } from "../interactions/context";
import { reviewLandmark } from "../interactions/review";
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
	context
		.command("review <handle>")
		.requiredOption("--writer <id>", "写者或线程 ID")
		.description("人工复核一个地标（L1 验收数据源）；手势只对当前投影有效")
		.option("--endorse", "认可：这就是这次干活的核心")
		.option("--reject", "不认可：从核心集合里去掉它")
		.option("--reason <text>", "复核理由（可选）")
		.action(
			async (
				handle: string,
				options: {
					writer: string;
					endorse?: boolean;
					reject?: boolean;
					reason?: string;
				},
				command: Command,
			) => {
				if (Boolean(options.endorse) === Boolean(options.reject)) {
					throw new Error("请选择 --endorse 或 --reject 其中一个");
				}
				const event = await reviewLandmark(
					await resolveBlackboard(),
					options.writer,
					handle,
					options.endorse ? "endorse" : "reject",
					options.reason,
				);
				const opts = command.optsWithGlobals() as GlobalOptions;
				if (opts.json) return emitJson(event);
				if (!opts.quiet)
					console.log(
						`已记录地标复核：${handle} ${options.endorse ? "认可" : "不认可"}`,
					);
			},
		);
}
