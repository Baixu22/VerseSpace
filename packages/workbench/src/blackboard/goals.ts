import { join } from "node:path";
import { BlackboardDataError } from "../errors";
import { safeReaddir } from "../fs/atomic";
import { newId } from "../ids";
import type { WorkbenchPaths } from "../paths";
import { type Goal, type GoalStatus, goalSchema } from "../types/goal";
import { readYamlFile, writeYamlFile } from "../yamlio";

export interface NewGoalInput {
	title: string;
	acceptance?: Goal["acceptance"];
	dependsOn?: string[];
}

export function goalsApi(paths: WorkbenchPaths) {
	const fileFor = (id: string) => join(paths.goals, `${id}.yaml`);

	async function get(id: string): Promise<Goal | null> {
		try {
			return await readYamlFile(fileFor(id), goalSchema);
		} catch (error) {
			if (
				error instanceof BlackboardDataError &&
				error.message === "file not found"
			) {
				return null;
			}
			throw error;
		}
	}

	async function save(goal: Goal): Promise<void> {
		await writeYamlFile(fileFor(goal.id), goalSchema, goal);
	}

	return {
		async add(
			input: NewGoalInput,
			status: GoalStatus = "planned",
		): Promise<Goal> {
			const goal = goalSchema.parse({
				id: newId("g"),
				title: input.title,
				status,
				acceptance: input.acceptance ?? [],
				dependsOn: input.dependsOn ?? [],
			});
			await save(goal);
			return goal;
		},

		async list(): Promise<Goal[]> {
			const entries = await safeReaddir(paths.goals);
			const ids = entries
				.filter((name) => name.endsWith(".yaml"))
				.map((name) => name.slice(0, -".yaml".length));
			const goals = await Promise.all(ids.map((id) => get(id)));
			return goals
				.filter((goal): goal is Goal => goal !== null)
				.sort((a, b) => a.id.localeCompare(b.id));
		},

		get,
		save,

		async update(id: string, patch: Partial<Omit<Goal, "id">>): Promise<Goal> {
			const current = await get(id);
			if (!current) {
				throw new BlackboardDataError(`goal not found: ${id}`, fileFor(id));
			}
			const next = { ...current, ...patch, id };
			await save(next);
			return next;
		},
	};
}
