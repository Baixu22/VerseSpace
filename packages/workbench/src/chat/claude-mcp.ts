import { join } from "node:path";
import { writeFileAtomic } from "../fs/atomic";

/**
 * Wiring the premise ledger into the spawned Claude session (TF-0241).
 *
 * The same five read-only tools that `workbench mcp` exposes to external agents
 * are handed to the CLI this lane spawns, so the model can check premises,
 * footprints, resume cards, the tribunal queue and notices mid-turn instead of
 * waiting for a human to paste them. The stream already renders
 * `mcp_tool_use` / `mcp_tool_result` blocks, so the tool cards come for free.
 *
 * `WORKBENCH_CLAUDE_MCP=off` disables the wiring — an escape hatch for a CLI
 * build that does not understand `--mcp-config`, and for tests that drive a
 * fake agent which should not try to launch a real MCP server.
 */

export const MCP_SERVER_NAME = "workbench";

/** Namespaced tool ids Claude assigns to this server's tools (server + tool). */
export const WORKBENCH_MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}`;

export interface SelfInvocation {
	command: string;
	baseArgs: string[];
}

/**
 * How to re-invoke this workbench build as a subprocess.
 *
 * - Compiled single-file binary: `process.execPath` IS the workbench binary,
 *   and its entry runs the CLI — so `<binary> mcp` works. Bun's standalone
 *   builds report the embedded entry as a virtual `$bunfs` path that does not
 *   exist on disk.
 * - `bun run src/index.ts`: `process.execPath` is the Bun runtime and the entry
 *   module is a real file on disk — so `bun <entry> mcp` is needed.
 *
 * `mainExists` is injected for testing; by default it asks the filesystem
 * whether the entry module resolves to a real path.
 */
export function resolveSelfInvocation(opts?: {
	execPath?: string;
	mainPath?: string;
	mainExists?: boolean;
}): SelfInvocation {
	const execPath = opts?.execPath ?? process.execPath;
	const mainPath = opts?.mainPath ?? Bun.main;
	const mainExists =
		opts?.mainExists ??
		(() => {
			try {
				// A standalone binary's entry is a virtual `$bunfs/...` path; a dev
				// run's entry is a real file. statSync throwing means "not on disk".
				return require("node:fs").statSync(mainPath).isFile();
			} catch {
				return false;
			}
		})();
	// Standalone binary: the executable itself is the CLI entry.
	if (!mainExists || mainPath.includes("$bunfs") || mainPath.includes("~BUN")) {
		return { command: execPath, baseArgs: [] };
	}
	// Dev: run the entry module under the Bun runtime.
	return { command: execPath, baseArgs: [mainPath] };
}

/** The mcp-config document Claude Code reads (`--mcp-config <file>`). */
export function buildMcpConfig(
	workbenchRoot: string,
	invocation: SelfInvocation,
): { mcpServers: Record<string, { command: string; args: string[] }> } {
	return {
		mcpServers: {
			[MCP_SERVER_NAME]: {
				command: invocation.command,
				args: [...invocation.baseArgs, "mcp", "--root", workbenchRoot],
			},
		},
	};
}

/**
 * Write the mcp-config for a workbench root and return the flags to append to
 * the Claude command line, or `[]` when the wiring is disabled. The config
 * lives under the (git-ignored) `.workbench/` so it never enters the repo, and
 * `--allowedTools` auto-approves the read-only server so `-p` mode does not
 * stall on a permission prompt for tools that cannot mutate anything.
 */
export async function mcpConfigFlags(
	workbenchRoot: string,
	invocation: SelfInvocation = resolveSelfInvocation(),
): Promise<string[]> {
	if (process.env.WORKBENCH_CLAUDE_MCP === "off") {
		return [];
	}
	const configPath = join(workbenchRoot, "mcp", "claude-mcp.json");
	const config = buildMcpConfig(workbenchRoot, invocation);
	await writeFileAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
	return [
		"--mcp-config",
		configPath,
		"--allowedTools",
		WORKBENCH_MCP_TOOL_PREFIX,
	];
}
