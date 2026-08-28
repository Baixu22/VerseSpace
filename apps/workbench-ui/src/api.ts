export interface Goal {
	id: string;
	title: string;
	status: string;
	dependsOn: string[];
	staleReason?: string;
}

export interface Checkpoint {
	id: string;
	goal: string;
	workspot: string;
	lifecycle: string;
	assertion: string;
	verificationResult?: { status: string; output?: string; at: string };
}

export interface Workspot {
	id: string;
	status: string;
	binding: string;
	primaryTask: string;
	currentTask?: string;
	branch: string;
	worktreePath: string;
}

export interface RegistryEntry {
	key: string;
	canonicalPath: string;
	version: number;
}

export interface Decision {
	id: string;
	title: string;
	rationale: string;
	author: string;
	timestamp: string;
}

export interface WbEvent {
	timestamp: string;
	source: string;
	type: string;
	payload: unknown;
}

export interface DoctorIssue {
	check: string;
	severity: "error" | "warning";
	message: string;
	subject?: string;
}

export interface UiState {
	version: string;
	project: string;
	goals: Goal[];
	queue: string[];
	workspots: Workspot[];
	checkpoints: {
		staging: Checkpoint[];
		verified: Checkpoint[];
		failed: Checkpoint[];
	};
	interfaces: RegistryEntry[];
	decisions: Decision[];
	events: WbEvent[];
	doctor: { ok: boolean; issues: DoctorIssue[] };
}

export interface SyncResult {
	applied: number;
	dispatches: unknown[];
	reanchored: string[];
	notifications: { message: string; severity: string }[];
}

export async function fetchState(): Promise<UiState> {
	const response = await fetch("/api/state");
	if (!response.ok) {
		throw new Error(`/api/state ${response.status}`);
	}
	return response.json() as Promise<UiState>;
}

export async function triggerSync(): Promise<SyncResult> {
	const response = await fetch("/api/sync", { method: "POST" });
	if (!response.ok) {
		throw new Error(`/api/sync ${response.status}`);
	}
	return response.json() as Promise<SyncResult>;
}
