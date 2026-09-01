/**
 * 自动扇出变体（TF-0094）。
 *
 * 生成 N 个、展示 1 个、其余留在一个按键之外：请求按 fanout 并发发出，
 * 第一个（流式展示的主回答）直接呈现给用户——没有任何「请选择」界面；
 * 其余变体作为备选文本挂在同一条助手消息上，消息上的常显 chip 一击展开。
 *
 * 纯函数模块：fanout 夹取、备选文本集合的构造（去空、去重、封顶）。
 */

export const FANOUT_DEFAULT = 1;
export const FANOUT_MAX = 3;

/** fanout 配置夹取：1（关）到 FANOUT_MAX；非法值一律回退默认。 */
export function clampFanout(value: number | undefined): number {
	if (
		value === undefined ||
		!Number.isFinite(value) ||
		!Number.isInteger(value) ||
		value < 1
	) {
		return FANOUT_DEFAULT;
	}
	return Math.min(value, FANOUT_MAX);
}

/**
 * 从主回答与 shadow 回答构造备选集合：不含主回答本身，去空、去
 * 重复（与主回答相同或彼此相同的 shadow 只留一次），并按 fanout-1 封顶。
 */
export function buildVariants(
	primary: string,
	shadows: string[],
	fanout: number,
): string[] {
	const cap = Math.max(0, clampFanout(fanout) - 1);
	if (cap === 0) {
		return [];
	}
	const variants: string[] = [];
	for (const shadow of shadows) {
		const text = shadow.trim();
		if (!text) {
			continue;
		}
		if (text === primary.trim()) {
			continue;
		}
		if (variants.includes(text)) {
			continue;
		}
		variants.push(text);
		if (variants.length >= cap) {
			break;
		}
	}
	return variants;
}
