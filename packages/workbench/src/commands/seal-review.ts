import type { Command } from "commander";
import { emitJson, type GlobalOptions } from "../output";
import { reviewSeal } from "../runtime/seal-review";
import { resolveBlackboard } from "./context";

export function registerSealReviewCommand(premises: Command): void {
	premises
		.command("review-seal <event-id>")
		.description("复核一次真实封印是否正确，保留事件引用和人工依据")
		.option("--correct", "这次阻断正确")
		.option("--incorrect", "这次阻断不正确")
		.requiredOption("--reason <text>", "复核依据")
		.action(
			async (
				eventId: string,
				options: { correct?: boolean; incorrect?: boolean; reason: string },
				command: Command,
			) => {
				if (Boolean(options.correct) === Boolean(options.incorrect))
					throw new Error("请选择 --correct 或 --incorrect 其中一个");
				const event = await reviewSeal(
					await resolveBlackboard(),
					eventId,
					Boolean(options.correct),
					options.reason,
				);
				const opts = command.optsWithGlobals() as GlobalOptions;
				if (opts.json) return emitJson(event);
				if (!opts.quiet) console.log(`已记录封印复核：${event.id}`);
			},
		);
}
