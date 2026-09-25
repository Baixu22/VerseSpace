/**
 * Policy loading — the one place the hand-written rules and the frozen
 * local-only inventory are merged.
 *
 * Kept out of `classify.mjs` so that file stays pure (no filesystem access),
 * and kept out of the CLI so tests exercise the exact same merge the gate does.
 */
import { existsSync, readFileSync } from "node:fs";

/**
 * Merge `policy.json` with `legacy-local-docs.json`.
 *
 * The inventory is appended LAST on purpose. Rules are first-match-wins, so the
 * inventory only ever classifies paths that no explicit rule claimed — which is
 * precisely the set it was generated from. If a later round adds an explicit
 * rule for a path, that rule wins and the inventory entry becomes dead weight
 * to be removed.
 */
export function loadPolicy({ policyPath, inventoryPath }) {
	const policy = JSON.parse(readFileSync(policyPath, "utf8"));
	if (inventoryPath && existsSync(inventoryPath)) {
		const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
		policy.rules = [
			...(policy.rules ?? []),
			{
				globs: inventory.paths ?? [],
				class: inventory.class ?? "process-evidence",
				why:
					inventory.why ??
					`冻结清单 ${inventory.generatedAt ?? ""}：本机留存的按日期文档`,
			},
		];
	}
	return policy;
}
