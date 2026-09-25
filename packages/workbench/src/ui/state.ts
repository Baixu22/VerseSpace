import type { Blackboard } from "../blackboard";
import { publicChatConfig } from "../chat/credentials";

import { runDoctor } from "../doctor";

import { WORKBENCH_VERSION } from "../version";

export interface UiState {
	version: string;
	project: string;
	config: unknown;
	/** Set when `.workbench/workbench.yaml` could not be read (TF-0260). */
	configError: string | null;
	goals: unknown[];
	queue: string[];
	workspots: unknown[];
	checkpoints: {
		staging: unknown[];
		verified: unknown[];
		failed: unknown[];
	};
	/** checkpoint id → owning workspot, for lane grouping. */
	checkpointsByWorkspot: Record<string, unknown[]>;
	/** Per-workspot recent activity (newest first), the lane feed. */
	activity: Record<string, unknown[]>;
	/** Latest agent batch session per workspot, with human-readable tail. */
	agentSessions: Record<
		string,
		{ session: unknown; lastLines: string[] } | null
	>;
	interfaces: unknown[];
	decisions: unknown[];
	events: unknown[];
	doctor: { ok: boolean; issues: unknown[]; error?: string };
}

/**
 * TF-0260 (F-06): a corrupt `workbench.yaml` must not collapse the whole state
 * surface into a bare 500 — the failure is data, so `/api/state` can report
 * "config unreadable" instead of looking like a dead server.
 */
async function settle<T>(
	run: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
	try {
		return { ok: true, value: await run() };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function collectState(bb: Blackboard): Promise<UiState> {
	const [
		configResult,
		goals,
		queue,
		workspots,
		checkpoints,
		interfaces,
		decisions,
		events,
		doctorResult,
	] = await Promise.all([
		settle(() => bb.config.load()),
		bb.goals.list(),
		bb.state.queue.get(),
		bb.state.workspots.list(),
		bb.checkpoints.scanAll(),
		bb.interfaces.list(),
		bb.decisions.list(),
		bb.events.tail(200),
		settle(() => runDoctor(bb)),
	]);

	// map every checkpoint to its workspot so lane cards can show their own
	// checkpoints, and route checkpoint events into the right lane
	const cpOwner = new Map<string, string>();
	const checkpointsByWorkspot: Record<string, unknown[]> = {};
	for (const cp of [
		...checkpoints.staging,
		...checkpoints.verified,
		...checkpoints.failed,
	]) {
		cpOwner.set(cp.id, cp.workspot);
		const owned = checkpointsByWorkspot[cp.workspot] ?? [];
		owned.push(cp);
		checkpointsByWorkspot[cp.workspot] = owned;
	}

	const activity: Record<string, unknown[]> = {};
	const laneOf = (event: { type: string; payload: unknown }): string | null => {
		const payload = event.payload as Record<string, unknown> | null;
		if (payload && typeof payload.workspotId === "string") {
			return payload.workspotId;
		}
		if (payload && typeof payload.cpId === "string") {
			return cpOwner.get(payload.cpId) ?? null;
		}
		return null;
	};
	for (const event of events) {
		const lane = laneOf(event);
		if (lane) {
			const feed = activity[lane] ?? [];
			feed.push(event);
			activity[lane] = feed;
		}
	}
	for (const list of Object.values(activity)) {
		list.reverse(); // newest first per lane
	}

	const { readAgentView } = await import("../agents/runner");
	const agentSessions: Record<
		string,
		{ session: unknown; lastLines: string[] } | null
	> = {};
	for (const workspot of workspots) {
		agentSessions[workspot.id] = await readAgentView(bb, workspot.id);
	}

	const config = configResult.ok ? configResult.value : null;
	const doctor = doctorResult.ok
		? doctorResult.value
		: { ok: false, issues: [], error: doctorResult.error };

	return {
		version: WORKBENCH_VERSION,
		project: bb.projectRoot,
		config: config ? { ...config, chat: publicChatConfig(config.chat) } : null,
		configError: configResult.ok ? null : configResult.error,
		goals,
		queue,
		workspots,
		checkpoints,
		checkpointsByWorkspot,
		activity,
		agentSessions,
		interfaces,
		decisions,
		events: events.reverse(),
		doctor,
	};
}
