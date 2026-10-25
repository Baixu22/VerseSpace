/** One bounded subprocess per group/case; stdout's final line is the observation. */

import { type EnhancedMode, runEnhanced } from "./enhanced";
import { fixture } from "./judge.mjs";

const [group, id] = process.argv.slice(2);
const spec = fixture.cases.find((item: { id: string }) => item.id === id);
if (!spec) throw new Error("unknown frozen case");
let result: unknown;
if (group === "naive") {
	const { runNaive } = await import("./naive.mjs");
	const { cwd: _cwd, ...row } = runNaive(spec);
	result = row;
} else if (group === "old") {
	const { runWorkbench } = await import("./workbench");
	result = await runWorkbench(spec);
} else result = await runEnhanced(spec, group as EnhancedMode);
console.log(JSON.stringify(result));
