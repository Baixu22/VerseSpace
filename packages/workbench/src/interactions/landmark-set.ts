/**
 * L1 候选集合的唯一定义：**种类门 + 分母口径**。
 *
 * 这个模块单独存在只有一个理由：复核手势（`reviewLandmark`）与 L1 读数
 * （`currentLandmarkAcceptance`）必须共用同一份实现。2026-09-11 彩排踩过一次
 * 「队列展示用会话时钟下的文件级地标、回填校验用默认时钟下的投影表」——两段口径
 * 一分家，界面上三条待办**全部**被拒，复核通道整体失效。
 *
 * 依赖方向：`context.ts` ← 本模块 ← {`review.ts`, `review-stats.ts`}。没有环。
 */

import type { WorkbenchEvent } from "../types/event";
import { interestFromEvents, sessionFileTopK } from "./context";

/** 写者身份的最小投影：L1 只需 id 与 kind。门一旦依赖更多信息就不再是「最窄的门」。 */
export interface WriterRef {
	id: string;
	kind: string;
}

/**
 * 记录型写者种类：git 监视与 human 编辑器。
 *
 * 门为什么按**种类**而不是内容或频率：git 监视会话的「全部工作」就是在少数文件上
 * 反复落笔，它记录的是「文件被动过」，不是「这段会话干的是什么」；human 编辑器同理
 * （另开一个窗口敲几行，与这段会话无关）。2026-09-11 四现场实测：全部文件级阈值地标
 * **100%** 来自这两类写者，而 agent 会话 415+ 次真实触碰产出 0 条。
 *
 * 这是最窄的门——只看 `writer.kind`，不看内容、不看频率，所以它只清噪声不杀真信号
 * （回归门实测：agent 集合门前后完全一致，git 集合被清空）。
 */
export const RECORDING_WRITER_KINDS: ReadonlySet<string> = new Set([
	"git",
	"human",
]);

export function isRecordingWriter(writer: WriterRef): boolean {
	return RECORDING_WRITER_KINDS.has(writer.kind);
}

/**
 * L1 的分母口径。**默认 `threshold`（不切）**：切换必须是显式的，口径变更不是
 * 一次代码改动，调用点要自己声明用的是哪把尺子，否则读数会不知不觉换含义。
 *
 * - `threshold`：DOI > landmarkFloor 的文件级集合（历史可比，TF-0057 的原文口径）。
 * - `session-top-k`：每会话文件级 top-K（TF-0159 的新定义）。绝对阈值要求「同一个
 *   handle 在衰减窗口内被推过 10 分」，而真实形状是很多文件各被碰一两次（权重 1–2）；
 *   跨四个现场实测**门后全部归零**——分母空了，判据不是 0 分而是**不可计算**。
 */
export type LandmarkDenominator = "threshold" | "session-top-k";

/** 相对口径的默认 K：与 positioning-v6 §11「每会话 3–5 条」的下沿一致。 */
export const DEFAULT_LANDMARK_TOP_K = 3;

export interface LandmarkCandidateOptions {
	denominator?: LandmarkDenominator;
	topK?: number;
	/** 判定路径的参考时刻默认取会话时钟，这里只作为它对不齐时的回退值。 */
	now?: number;
}

/**
 * 该写者在当前口径下的 L1 候选 handle。
 *
 * 两条口径的共同点（也是不能动的地方）：单位是**文件级**（目录与项目根不进集合），
 * 参考时刻是**会话自己的时钟**（§11 问的是「一段会话结束后能列出什么」；按「现在」
 * 算的话同一段会话的地标会随日期流逝自己跌到线下，读数既不可复现也不可归因）。
 */
export function landmarkCandidates(
	events: WorkbenchEvent[],
	writer: string,
	options: LandmarkCandidateOptions = {},
): string[] {
	const now = options.now ?? Date.now();
	if ((options.denominator ?? "threshold") === "session-top-k") {
		return sessionFileTopK(
			events,
			writer,
			options.topK ?? DEFAULT_LANDMARK_TOP_K,
			now,
		);
	}
	// 阈值口径：DOI > landmarkFloor 且为文件级。2026-09-11 实测目录占 33%–75%，
	// 且阈值越低占比越高——「调低阈值提高覆盖」会把分母越调越脏。
	return interestFromEvents(events, writer, now, { clock: "session" })
		.fileLandmarkHandles;
}
