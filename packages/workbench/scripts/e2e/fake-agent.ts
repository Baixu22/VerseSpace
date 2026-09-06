/**
 * E2E fake agent: a REAL process that speaks the claude stream-json protocol
 * (the same wire format the ChatThreads runner consumes) while behaving
 * deterministically. It is not a mock library object — it spawns, reads real
 * stdin, writes real files and hashes get taken against the real filesystem.
 *
 * The runner over `WORKBENCH_CHAT_COMMAND` points at this script. Prompts
 * carry directives, one per line:
 *
 *   READ <path>                  -> emits a Read tool_use (footprint `used`)
 *   READSPAN <path> <off> <lim>  -> Read with offset/limit: the claim carries
 *                                   a line span, so edits outside it are the
 *                                   L2 suppression path, not invalidations
 *   WRITE <path>                 -> writes the file for real, emits a Write
 *     <content lines ...>           tool_use (footprint `generated`)
 *   __END_WRITE__
 *
 * Anything else becomes plain assistant text. Each turn ends with a
 * `result: success` line, exactly like the real CLI.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

function argValue(name: string): string | undefined {
	const argv = process.argv.slice(2);
	const index = argv.indexOf(name);
	return index >= 0 ? (argv[index + 1] as string | undefined) : undefined;
}

const resumed = argValue("--session-id") ?? argValue("--resume");
const sessionId = resumed ?? `fake-${crypto.randomUUID().slice(0, 8)}`;
const projectRoot = process.cwd();

const write = (event: Record<string, unknown>): void => {
	process.stdout.write(`${JSON.stringify(event)}\n`);
};

write({
	type: "system",
	subtype: "init",
	session_id: sessionId,
	model: "fake-agent",
	cwd: projectRoot,
});

interface Directive {
	kind: "read" | "span" | "write";
	path: string;
	content?: string[];
	offset?: number;
	limit?: number;
}

function parseDirectives(text: string): {
	directives: Directive[];
	prose: string[];
} {
	const directives: Directive[] = [];
	const prose: string[] = [];
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i += 1) {
		const readMatch = lines[i]!.match(/^READ\s+(.+)$/);
		if (readMatch) {
			directives.push({ kind: "read", path: readMatch[1]!.trim() });
			continue;
		}
		const spanMatch = lines[i]!.match(/^READSPAN\s+(.+?)\s+(\d+)\s+(\d+)$/);
		if (spanMatch) {
			directives.push({
				kind: "span",
				path: spanMatch[1]!.trim(),
				offset: Number(spanMatch[2]),
				limit: Number(spanMatch[3]),
			});
			continue;
		}
		const writeMatch = lines[i]!.match(/^WRITE\s+(.+)$/);
		if (writeMatch) {
			const content: string[] = [];
			i += 1;
			while (i < lines.length && lines[i] !== "__END_WRITE__") {
				content.push(lines[i]!);
				i += 1;
			}
			directives.push({
				kind: "write",
				path: writeMatch[1]!.trim(),
				content,
			});
			continue;
		}
		if (lines[i]) prose.push(lines[i]!);
	}
	return { directives, prose };
}

async function runTurn(prompt: string): Promise<void> {
	const { directives, prose } = parseDirectives(prompt);
	let toolIndex = 0;
	for (const directive of directives) {
		toolIndex += 1;
		const toolCallId = `toolu_e2e_${toolIndex}`;
		const abs = resolve(projectRoot, directive.path);
		if (directive.kind === "read" || directive.kind === "span") {
			let content = "";
			try {
				content = await readFile(abs, "utf8");
			} catch {
				content = "";
			}
			const input: Record<string, unknown> = { file_path: abs };
			if (directive.kind === "span") {
				input.offset = directive.offset;
				input.limit = directive.limit;
			}
			write({
				type: "assistant",
				message: {
					content: [
						{
							type: "tool_use",
							id: toolCallId,
							name: "Read",
							input,
						},
					],
				},
			});
			write({
				type: "user",
				message: {
					content: [
						{
							type: "tool_result",
							tool_use_id: toolCallId,
							content: content.slice(0, 2000) || "(empty)",
						},
					],
				},
			});
			continue;
		}
		const content = (directive.content ?? []).join("\n");
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, `${content}\n`, "utf8");
		write({
			type: "assistant",
			message: {
				content: [
					{
						type: "tool_use",
						id: toolCallId,
						name: "Write",
						input: { file_path: abs, content: `${content}\n` },
					},
				],
			},
		});
		// The runner hashes generated claims at tool_result time, so the file
		// must already hold the new content when this line leaves the process.
		write({
			type: "user",
			message: {
				content: [
					{ type: "tool_result", tool_use_id: toolCallId, content: "ok" },
				],
			},
		});
	}
	const summary = directives.length
		? directives.map((d) => `${d.kind}:${d.path}`).join(", ")
		: "no-op";
	const reply = prose.length
		? prose.join(" ")
		: `e2e agent turn done (${summary})`;
	write({
		type: "assistant",
		message: { content: [{ type: "text", text: reply }] },
	});
	write({ type: "result", subtype: "success", is_error: false, result: reply });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
	let event: Record<string, unknown>;
	try {
		event = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return;
	}
	if (event.type !== "user") return;
	const message = event.message as { content?: unknown } | undefined;
	const prompt = typeof message?.content === "string" ? message.content : "";
	void runTurn(prompt);
});
