const CRASH_WINDOW_MS = 60_000;
const CRASH_LIMIT = 3;
const crashLog = new Map<string, number[]>();

function crashKey(registryDir: string, label: string): string {
	return `${registryDir}::${label}`;
}

export function recordCrash(registryDir: string, label: string): void {
	const key = crashKey(registryDir, label);
	const now = Date.now();
	const stamps = (crashLog.get(key) ?? []).filter(
		(at) => now - at < CRASH_WINDOW_MS,
	);
	stamps.push(now);
	crashLog.set(key, stamps);
}

/** True once the label accumulated `CRASH_LIMIT` abnormal exits in a minute. */
export function crashLoopTripped(registryDir: string, label: string): boolean {
	const key = crashKey(registryDir, label);
	const now = Date.now();
	const stamps = (crashLog.get(key) ?? []).filter(
		(at) => now - at < CRASH_WINDOW_MS,
	);
	crashLog.set(key, stamps);
	return stamps.length >= CRASH_LIMIT;
}
