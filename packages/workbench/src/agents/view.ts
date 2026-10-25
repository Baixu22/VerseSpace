import { readFile } from "node:fs/promises";
import type { Blackboard } from "../blackboard";
import { inputCoverageView } from "../blackboard/input-coverage";
import { type AgentSession, readLatestSession } from "./session";

/** Pull the human-visible text out of one captured stream line. */
export function describeStreamLine(raw: string): string {
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (parsed.type === "assistant" && typeof parsed.message === "object") {
			const message = parsed.message as {
				content?: Array<{ type?: string; text?: string }>;
			};
			const text = (message.content ?? [])
				.filter((part) => part.type === "text")
				.map((part) => part.text ?? "")
				.join(" ")
				.trim();
			if (text) {
				return text;
			}
		}
		if (parsed.type === "result") {
			return `结果：${String(parsed.result ?? parsed.subtype ?? "")}`;
		}
		return String(parsed.type ?? raw.slice(0, 80));
	} catch {
		return raw.slice(0, 120);
	}
}

/** Session + the last few human-readable stream lines, for the lane card. */
export async function readAgentView(
	bb: Blackboard,
	workspotId: string,
): Promise<{
	session: AgentSession | null;
	lastLines: string[];
	inputCoverage: Awaited<ReturnType<typeof inputCoverageView>>;
}> {
	const session = await readLatestSession(bb, workspotId);
	if (!session) {
		return {
			session: null,
			lastLines: [],
			inputCoverage: await inputCoverageView(bb, `agent:${workspotId}`),
		};
	}
	let lastLines: string[] = [];
	try {
		const raw = await readFile(session.logFile, "utf8");
		const lines = raw
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.slice(-5)
			.map((line) => {
				try {
					const parsed = JSON.parse(line) as { kind?: string; line?: string };
					return describeStreamLine(parsed.line ?? "");
				} catch {
					return line.slice(0, 120);
				}
			});
		lastLines = lines;
	} catch {
		// log not written yet (process still starting)
	}
	return {
		session,
		lastLines,
		inputCoverage: await inputCoverageView(bb, `agent:${workspotId}`),
	};
}
