import { join } from "node:path";
import { safeReaddir } from "../fs/atomic";
import { newId } from "../ids";
import type { WorkbenchPaths } from "../paths";
import { type Decision, decisionSchema } from "../types/decision";
import { readYamlFile, writeYamlFile } from "../yamlio";

/**
 * Decisions are append-only: `add` creates a new file and nothing offers an
 * update or delete. Corrections arrive as a new decision that supersedes the
 * old one, keeping the audit trail intact.
 */
export function decisionsApi(paths: WorkbenchPaths) {
	const fileFor = (id: string) => join(paths.decisions, `${id}.yaml`);

	return {
		async add(
			input: Omit<Decision, "id" | "timestamp"> & {
				id?: string;
				timestamp?: string;
			},
		): Promise<Decision> {
			const decision = decisionSchema.parse({
				id: input.id ?? newId("d"),
				title: input.title,
				rationale: input.rationale,
				timestamp: input.timestamp ?? new Date().toISOString(),
				author: input.author,
			});
			await writeYamlFile(fileFor(decision.id), decisionSchema, decision);
			return decision;
		},

		async list(): Promise<Decision[]> {
			const entries = await safeReaddir(paths.decisions);
			const ids = entries
				.filter((name) => name.endsWith(".yaml"))
				.map((name) => name.slice(0, -".yaml".length));
			const decisions = await Promise.all(
				ids.map((id) => readYamlFile(fileFor(id), decisionSchema)),
			);
			return decisions.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
		},
	};
}
