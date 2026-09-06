/**
 * 交互事件（L1 隐式上下文层的输入流，TF-0087）。
 *
 * 交互事件统一描述「谁在何时触碰了仓库里的什么」：
 *  - agent 侧：由 R1 的 PROV 足迹派生（used → selection，generated → edit）；
 *  - 人类侧：未来由前端交互层（v6）直接上报。
 * 两类来源落进同一条 events.jsonl（source="interactions", type="interaction"），
 * 与 footprint 事件共用同一个 seq 时钟（行号），DOI 衰减（TF-0088）据此排序。
 *
 * 6 字段：time / kind / origin / contentType / handle / delta。
 */

/** 交互种类：selection=触碰未改，edit=改动（权重更高），command=无文件交互。 */
export type InteractionKind =
	| "selection"
	| "edit"
	| "command"
	| "interest-reduced";

/** DOI 出厂权重（TF-0088 消费）：selection=1，edit≈2，command=0。 */
export const INTERACTION_WEIGHT: Record<InteractionKind, number> = {
	selection: 1,
	edit: 2,
	command: 0,
	"interest-reduced": 0,
};

/** contentType 取值：决定 DOI 向父级传播的层级（文件 → 目录 → 项目）。 */
export const CONTENT_TYPES = ["file", "directory", "symbol"] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

export interface InteractionEvent {
	/** 事件发生时间（ISO 8601）。 */
	time: string;
	/** selection / edit / command。 */
	kind: InteractionKind;
	/** 写者 id（人 / agent / git / CI），事件按它分组。 */
	origin: string;
	/** file / directory / symbol：DOI 父级传播的层级依据。 */
	contentType: ContentType;
	/** 确定性句柄：相对仓库根的 POSIX 路径，或符号名。 */
	handle: string;
	/** 变化量：edit 的改动行数、selection 的读取范围行数；未知为 0。 */
	delta: number;
}

/** 事件在 events.jsonl 中的来源标记。 */
export const INTERACTIONS_SOURCE = "interactions";
export const INTERACTIONS_TYPE = "interaction";
