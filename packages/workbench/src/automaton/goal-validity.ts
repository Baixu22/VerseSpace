import type { Goal } from "../types/goal";
import type { WorldSnapshot } from "../types/snapshot";

/** A completion anchor must still exist, on disk and at its recorded revision. */
export function staleGoalReason(
	goal: Goal,
	snapshot: WorldSnapshot,
): string | undefined {
	for (const [key, version] of Object.entries(
		goal.verifiedAgainst.interfaces,
	)) {
		const entry = snapshot.interfaces.find(
			(candidate) => candidate.key === key,
		);
		if (!entry || snapshot.missingInterfaces?.includes(key)) {
			return `锚定接口 ${key} 的注册项或契约文件已缺失`;
		}
		if (entry.version !== version) {
			return `锚定接口 ${key} 已从 v${version} 漂移到 v${entry.version}`;
		}
	}
	return undefined;
}

export function currentGoalStatus(
	goal: Goal,
	snapshot: WorldSnapshot,
): Goal["status"] {
	return goal.status === "done" && staleGoalReason(goal, snapshot)
		? "stale_done"
		: goal.status;
}

export function incompleteDependencies(
	goal: Goal,
	snapshot: WorldSnapshot,
): string[] {
	return goal.dependsOn.filter((id) => {
		const dependency = snapshot.goals.find((candidate) => candidate.id === id);
		return !dependency || currentGoalStatus(dependency, snapshot) !== "done";
	});
}
