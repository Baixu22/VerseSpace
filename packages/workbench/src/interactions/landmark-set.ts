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
import {
	INTERACTIONS_SOURCE,
	INTERACTIONS_TYPE,
	type InteractionEvent,
} from "./types";

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

/**
 * 「只有触碰、没有落笔」的候选是否算地标。**默认 true（只认可产出）**。
 *
 * 依据是 2026-09-11 两轮真人复核（VAS1EM + 1OioVM，共 22 条真实候选）：
 * 用户判据是「是否承载该会话的主要分析或实际改动」，据此驳回的 10 条里
 * **全部**都是「只有 selection、没有 edit」（纯浏览），而认可的 12 条里
 * **11 条有 edit**。「有没有落笔」在两轮里命中 21/22 = 95.5%；加上**只读会话
 * 豁免**（整段会话零落笔时过滤退位）后 22/22。
 *
 * **翻默认记录（2026-09-11，用户决策）**：翻默认的三条前置全部完成后显式切换——
 * ① 新口径集合重跑真人复核：VAS1EM 6/6、1OioVM 9/9（含 3 条全新人答）= 1.0000，
 *   均 ≥ 0.8（TF-0057 判据满足）；② 只读会话豁免落库（n=1 诚实声明在案）；
 * ③ 双口径并报基础设施落库（stats/CLI/账本/监控/队列五处）。旧口径（不过滤）
 * 在同一批真人回答下是 VAS1EM 0.6000、1OioVM 0.5000——差距就是被过滤的纯浏览噪声。
 * 证据与过程：`docs/tf-0161-require-edits-measurement.md`。**回滚 = 显式传
 * `requireEdits: false`**（队列的回滚开关是 `--unfiltered`），对照读数保留一个周期。
 */
export const DEFAULT_REQUIRE_EDITS = true;

export interface LandmarkCandidateOptions {
	denominator?: LandmarkDenominator;
	topK?: number;
	/** 判定路径的参考时刻默认取会话时钟，这里只作为它对不齐时的回退值。 */
	now?: number;
	/**
	 * 只保留**至少有一次落笔（edit）**的候选（默认 `DEFAULT_REQUIRE_EDITS`，
	 * 2026-09-11 已翻默认为开）。
	 *
	 * 为什么这是「清噪声」而不是「误杀真信号」：两轮真实现场实测，被驳回的
	 * 纯浏览候选（`src/notes.md`、分叉里只 selection 的 `src/family.ts`、
	 * 被复核的 `src/base-url.ts`）与认可候选的区别不在「碰得多不多」，而在
	 * **有没有留下改动**。它按 `kind` 判，不看内容、不看频率，和种类门同一个
	 * 设计原则——**门只看最窄的那个信号**。
	 *
	 * **只读会话豁免**：整段会话一次 edit 都没有时，过滤退位、原样返回。
	 * 依据是 22 条真人标注上的规则对比（`landmark-readonly-session-sweep.ts`）：
	 * 条目级过滤命中 21/22，唯一错判就是「专门去复核某个文件」的会话
	 * （VAS1EM `21273cbd`，只读是它的工作本身）；加上豁免后 22/22，且豁免
	 * 只多留零落笔会话的候选、不恢复任何有落笔会话里的纯浏览项（1OioVM
	 * 集合不变，VAS1EM 5 → 6，多出的恰是被认可的那条）。豁免按会话级判，
	 * 仍只看「有没有 edit」这一个信号。
	 *
	 * **回滚**：传 `requireEdits: false` 得到翻默认前的未过滤集合（对照读数
	 * 与回滚开关都用它，保留一个周期）。
	 */
	requireEdits?: boolean;
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
	const raw =
		(options.denominator ?? "threshold") === "session-top-k"
			? sessionFileTopK(
					events,
					writer,
					options.topK ?? DEFAULT_LANDMARK_TOP_K,
					now,
				)
			: // 阈值口径：DOI > landmarkFloor 且为文件级。2026-09-11 实测目录占 33%–75%，
				// 且阈值越低占比越高——「调低阈值提高覆盖」会把分母越调越脏。
				interestFromEvents(events, writer, now, { clock: "session" })
					.fileLandmarkHandles;
	if (!(options.requireEdits ?? DEFAULT_REQUIRE_EDITS)) return raw;
	// 只保留有过落笔的候选。**先尺后门**在这里不成立：这条过滤必须作用在
	// 「已经被尺子选出来的集合」上，替换掉纯浏览项，而不是在排序前过滤——
	// 否则 top-K 的 K 会被过滤前后的一致性问题搅乱（K 是「问人几条」的预算，
	// 不是「过滤后还剩几条」）。所以按原顺序筛，保住集合的确定性。
	const edited = new Set(
		events
			.filter((event) => {
				if (
					event.source !== INTERACTIONS_SOURCE ||
					event.type !== INTERACTIONS_TYPE
				)
					return false;
				const item = event.payload as Partial<InteractionEvent> | null;
				if (!item || item.origin !== writer) return false;
				return item.kind === "edit";
			})
			.map((event) => (event.payload as InteractionEvent).handle),
	);
	// 只读会话豁免：整段会话一次落笔都没有时，「读」就是它的工作（复核、审计、
	// 纯阅读会话），条目级过滤会把它的全部候选清成空集——那不是清噪声，是把
	// 唯一能填 human 那格的路径堵死（VAS1EM `21273cbd` 实测误杀）。豁免按
	// 会话级判：只看该写者有没有 edit 事件，不看频率、不看内容。
	if (edited.size === 0) return raw;
	return raw.filter((handle) => edited.has(handle));
}
