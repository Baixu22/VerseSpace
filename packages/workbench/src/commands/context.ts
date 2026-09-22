import { type Blackboard, openBlackboard } from "../blackboard";
import { NoWorkbenchError } from "../errors";
import { findWorkbenchRoot } from "../paths";

/**
 * Locate and open the nearest `.workbench/` walking up from cwd. An explicit
 * `root` (the `.workbench` directory itself) skips discovery — the chat lane's
 * spawned MCP server passes it so the ledger is found regardless of the working
 * directory Claude Code launches the child in.
 */
export async function resolveBlackboard(root?: string): Promise<Blackboard> {
	const resolved = root ?? (await findWorkbenchRoot());
	if (!resolved) {
		throw new NoWorkbenchError(process.cwd());
	}
	return openBlackboard(resolved);
}
