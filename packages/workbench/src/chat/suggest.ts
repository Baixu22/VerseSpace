/**
 * 系统提议的下一步（TF-0095）。
 *
 * 回答之后给 2-3 个从对话推导出的发散续写：建议是纯推导（不额外调用
 * 模型、不付任何前置成本），每个建议都是一次点击——点击即作为下一条
 * 用户消息发送，绝不要求用户打字。
 *
 * 推导顺序：优先用助手回答里真实存在的结构（编号/列表项、留下的开放
 * 问题、下一步标记），没有结构时回退到通用发散方向。
 */

import type { StoredMessage } from "./threads";

export interface Suggestion {
	/** 点击后作为用户消息发送的完整文本。 */
	text: string;
	/** 推导来源（可观测，便于用户理解为什么提议它）。 */
	kind: "option" | "question" | "next-step" | "diverge";
}

/** 通用发散方向：回答没有可提取结构时的兜底。 */
const DIVERGE_FALLBACKS: Suggestion[] = [
	{ text: "换一个角度重新回答这个问题", kind: "diverge" },
	{ text: "列出这个回答的风险、前提与反例", kind: "diverge" },
	{ text: "把它落成一份可执行的步骤清单", kind: "diverge" },
];

const NEXT_STEP_RE = /^(接下来|下一步|然后)[，,：:．\s]/;

/** 从助手回答文本里提取可续写的结构行（最多 limit 条）。 */
function extractLines(text: string): {
	options: string[];
	questions: string[];
	steps: string[];
} {
	const options: string[] = [];
	const questions: string[] = [];
	const steps: string[] = [];
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.length < 4) {
			continue;
		}
		// 编号/列表项：真正的「分支结构」才是值得续写的方向
		const option = line.match(/^(?:\d{1,2}[.、)]|[-*+•])\s+(.{4,})$/);
		if (option?.[1]) {
			options.push(option[1].trim().replace(/[。；;]$/, ""));
			continue;
		}
		// 助手留下的开放问题
		if (/[？?]$/.test(line)) {
			questions.push(line.replace(/\*\*/g, ""));
			continue;
		}
		// 显式的下一步标记
		if (NEXT_STEP_RE.test(line)) {
			steps.push(line.replace(/\*\*/g, ""));
		}
	}
	return { options, questions, steps };
}

/**
 * 从消息序列推导 2-3 个发散续写。最后一条不是助手回答、或对话为空
 * 时返回空数组（没有可续写的回答就不提议）。
 */
export function suggestNext(messages: StoredMessage[]): Suggestion[] {
	const last = messages.at(-1);
	if (last?.role !== "assistant") {
		return [];
	}
	const { options, questions, steps } = extractLines(last.text);
	const suggestions: Suggestion[] = [];
	// 每个来源最多取 2 条，保证三个来源都能出场（发散优先于单一来源堆量）
	for (const option of options.slice(0, 2)) {
		suggestions.push({
			text: `就「${truncate(option)}」继续展开`,
			kind: "option",
		});
	}
	for (const question of questions.slice(0, 2)) {
		suggestions.push({
			text: `回答你留下的问题：${truncate(question)}`,
			kind: "question",
		});
	}
	for (const step of steps.slice(0, 2)) {
		suggestions.push({
			text: truncate(step),
			kind: "next-step",
		});
	}
	// 有结构时也至少补一条发散方向；完全没结构时给三条
	for (const fallback of DIVERGE_FALLBACKS) {
		if (suggestions.length >= 3) {
			break;
		}
		suggestions.push(fallback);
	}
	return suggestions.slice(0, 3);
}

function truncate(text: string, max = 60): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
