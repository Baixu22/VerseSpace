export { splitCommandLine } from "./argv";
export { crashLoopTripped } from "./crash";
export type { LivenessVerdict, LivenessWatch } from "./liveness";
export {
	HEARTBEAT_INTERVAL_MS,
	STALL_MS,
	UNRESPONSIVE_MS,
	watchLiveness,
} from "./liveness";
export { spawnSupervised } from "./process";
export { isProcessAlive, killTree, reapOrphans } from "./registry";
export type { ProcHandle, SpawnOptions, SpawnOutcome } from "./types";
