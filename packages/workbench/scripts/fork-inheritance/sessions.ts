/**
 * TF-0140 · 会话文件读取（`~/.claude/projects/<转义 cwd>/<sessionId>.jsonl`）。
 *
 * 只保留带 uuid 的 user/assistant 行：queue-operation / attachment / mode /
 * last-prompt 这些控制行不进逐字比对，否则同一段对话在两次运行里行数就不同。
 */

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROJECTS = join(homedir(), ".claude", "projects");

/** 一条会话消息（只保留带 uuid 的 user/assistant，其余控制行不进比对）。 */
export interface Msg {
	uuid: string;
	type: "user" | "assistant";
	sessionId?: string;
	timestamp?: string;
	message?: {
		content?: unknown;
		usage?: Record<string, unknown>;
	};
}

export interface Usage {
	input: number;
	cacheCreate: number;
	cacheRead: number;
	output: number;
}

const num = (v: unknown): number => (typeof v === "number" ? v : 0);

export function usageOf(m: Msg): Usage | null {
	const u = m.message?.usage;
	if (!u) return null;
	return {
		input: num(u.input_tokens),
		cacheCreate: num(u.cache_creation_input_tokens),
		cacheRead: num(u.cache_read_input_tokens),
		output: num(u.output_tokens),
	};
}

/** 一条消息里的工具身份，按出现顺序 —— tool_use 与 tool_result 都算。 */
export function toolIds(m: Msg): string[] {
	const content = m.message?.content;
	if (!Array.isArray(content)) return [];
	const out: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: string; id?: string; tool_use_id?: string };
		if (b.type === "tool_use" && b.id) out.push(`use:${b.id}`);
		else if (b.type === "tool_result" && b.tool_use_id)
			out.push(`result:${b.tool_use_id}`);
	}
	return out;
}

export async function loadSession(path: string): Promise<Msg[]> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return [];
	}
	const out: Msg[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let d: Msg;
		try {
			d = JSON.parse(line) as Msg;
		} catch {
			continue;
		}
		if ((d.type === "user" || d.type === "assistant") && d.uuid) out.push(d);
	}
	return out;
}

/** 逐字共享前缀长度：同序、同 uuid 的消息条数。 */
export function commonPrefix(a: Msg[], b: Msg[]): number {
	let n = 0;
	while (n < a.length && n < b.length && a[n]!.uuid === b[n]!.uuid) n += 1;
	return n;
}

/** 不复刻 cwd 的转义规则，直接在所有 project 目录里找这个 session id。 */
export async function findSessionFile(id: string): Promise<string | null> {
	let projects: string[];
	try {
		projects = await readdir(PROJECTS);
	} catch {
		return null;
	}
	for (const project of projects) {
		const path = join(PROJECTS, project, `${id}.jsonl`);
		if (await Bun.file(path).exists()) return path;
	}
	return null;
}
