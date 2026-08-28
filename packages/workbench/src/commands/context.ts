import { type Blackboard, openBlackboard } from "../blackboard";
import { NoWorkbenchError } from "../errors";
import { findWorkbenchRoot } from "../paths";

/** Locate and open the nearest `.workbench/` walking up from cwd. */
export async function resolveBlackboard(): Promise<Blackboard> {
	const root = await findWorkbenchRoot();
	if (!root) {
		throw new NoWorkbenchError(process.cwd());
	}
	return openBlackboard(root);
}
