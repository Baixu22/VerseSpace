import type { Command } from "commander";

import { resolveBlackboard } from "../commands/context";
import { serveMcp } from "../mcp/server";

/**
 * `workbench mcp`：在 stdio 上以 MCP 协议暴露前提账本的只读查询通道。
 * 配置进 Claude Code / Cursor 的 mcpServers 即可被外部 agent 直接调用。
 */
export function registerMcp(program: Command): void {
	program
		.command("mcp")
		.description(
			"serve the premise ledger over MCP stdio (JSON-RPC 2.0, read-only tools)",
		)
		.option(
			"--root <dir>",
			"path to the .workbench directory (skips upward discovery; used when the chat lane spawns this server)",
		)
		.action(async (options: { root?: string }) => {
			const bb = await resolveBlackboard(options.root);
			await serveMcp(bb);
		});
}
