import { expect, test } from "bun:test";
import { spawnSupervised } from "./index";

test("argv input preserves spaces, quotes and multiline prompts", async () => {
	const args = [
		"two words",
		'quote " stays',
		"first\nsecond",
		"literal $(command)",
	];
	const lines: string[] = [];
	const proc = spawnSupervised(
		[
			process.execPath,
			"-e",
			"console.log(JSON.stringify(process.argv.slice(1)))",
			...args,
		],
		{
			label: "argv-regression",
			timeoutSeconds: 5,
			onLine: (line, kind) => {
				if (kind === "out") lines.push(line);
			},
		},
	);
	expect((await proc.wait()).exitCode).toBe(0);
	expect(JSON.parse(lines.join("\n"))).toEqual(args);
});
