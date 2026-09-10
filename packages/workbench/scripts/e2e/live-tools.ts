import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

const argsSchema = z
	.object({
		file_path: z.string().min(1),
		content: z.string().max(64_000).optional(),
		offset: z.number().int().positive().optional(),
		limit: z.number().int().positive().max(10_000).optional(),
	})
	.strict();

export const liveTools = [
	{
		type: "function",
		function: {
			name: "Read",
			description:
				"读取隔离工作区 src/ 下的文本文件，可选 1-based offset/limit。",
			parameters: {
				type: "object",
				properties: {
					file_path: { type: "string" },
					offset: { type: "integer", minimum: 1 },
					limit: { type: "integer", minimum: 1 },
				},
				required: ["file_path"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function",
		function: {
			name: "Write",
			description: "将完整文本写入隔离工作区 src/ 下的文件。",
			parameters: {
				type: "object",
				properties: {
					file_path: { type: "string" },
					content: { type: "string" },
				},
				required: ["file_path", "content"],
				additionalProperties: false,
			},
		},
	},
];

/** Test actor only: no shell, credentials, .workbench, absolute paths or links. */
export async function executeLiveTool(
	root: string,
	name: string,
	raw: unknown,
	readOnly = false,
) {
	if (name !== "Read" && name !== "Write") throw new Error("未开放的工具");
	const args = argsSchema.parse(raw);
	const path = args.file_path.replace(/\\/g, "/");
	const segments = path.split("/");
	if (
		segments[0] !== "src" ||
		segments.length < 2 ||
		segments.some((part) => !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part))
	) {
		throw new Error("只允许 src/ 下的普通相对路径");
	}
	if (name === "Write" && readOnly) throw new Error("plan 模式不允许写文件");
	for (let i = 1; i <= segments.length; i++) {
		const info = await lstat(join(root, ...segments.slice(0, i))).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return null;
				throw error;
			},
		);
		if (info?.isSymbolicLink()) throw new Error("不允许经过符号链接或目录联接");
	}
	const absolute = resolve(root, path);
	if (name === "Write") {
		if (typeof args.content !== "string") throw new Error("Write 缺少 content");
		await mkdir(dirname(absolute), { recursive: true });
		await writeFile(absolute, args.content, "utf8");
		return {
			input: { file_path: absolute, content: args.content },
			content: "文件已写入",
		};
	}
	const info = await lstat(absolute);
	if (!info.isFile() || info.size > 64_000)
		throw new Error("只读取不超过 64KB 的文本文件");
	const text = await readFile(absolute, "utf8");
	const start = (args.offset ?? 1) - 1;
	const content =
		args.offset === undefined && args.limit === undefined
			? text
			: text
					.split("\n")
					.slice(
						start,
						args.limit === undefined ? undefined : start + args.limit,
					)
					.join("\n");
	return { input: { ...args, file_path: absolute }, content };
}
