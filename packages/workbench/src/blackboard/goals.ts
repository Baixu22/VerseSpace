import { join } from "node:path";
import { BlackboardConflictError, BlackboardDataError } from "../errors";
import { safeReaddir } from "../fs/atomic";
import { withPidLock } from "../fs/lockfile";
import { newId } from "../ids";
import type { WorkbenchPaths } from "../paths";
import { type Goal, type GoalStatus, goalSchema } from "../types/goal";
import { readYamlFile, writeYamlFile } from "../yamlio";

export interface NewGoalInput {
	title: string;
	acceptance?: Goal["acceptance"];
	dependsOn?: string[];
}

export interface GoalUpdateOptions {
	/**
	 * CAS precondition: fail with `BlackboardConflictError` (carrying the
	 * current goal) instead of overwriting when another writer moved the
	 * version first. Omit to do a serialized read-modify-write.
	 */
	expectedVersion?: number;
}

export function goalsApi(paths: WorkbenchPaths) {
	const fileFor = (id: string) => join(paths.goals, `${id}.yaml`);
	// transient per-goal locks live outside the object directories so object
	// listings never see them
	const lockFor = (id: string) =>
		join(paths.root, "locks", "goals", `${id}.lock`);

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
				version: 1,
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

		async update(
			id: string,
			patch: Partial<Omit<Goal, "id">>,
			options: GoalUpdateOptions = {},
		): Promise<Goal> {
			// one file per goal means two writers can race the read-modify-write;
			// the per-goal lock serializes them, and the version precondition
			// turns a stale expectation into a detectable conflict with the
			// current value attached — never a silent lost update
			return withPidLock(lockFor(id), async () => {
				const current = await get(id);
				if (!current) {
					throw new BlackboardDataError(`goal not found: ${id}`, fileFor(id));
				}
				if (
					options.expectedVersion !== undefined &&
					current.version !== options.expectedVersion
				) {
					throw new BlackboardConflictError(
						`goal ${id} 版本前置条件不匹配（期望 v${options.expectedVersion}，当前 v${current.version}）`,
						fileFor(id),
						current,
					);
				}
				const next = goalSchema.parse({
					...current,
					...patch,
					id,
					version: current.version + 1,
				});
				await save(next);
				return next;
			});
		},
	};
}
