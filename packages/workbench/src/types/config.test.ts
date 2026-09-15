import { expect, test } from "bun:test";
import { workbenchConfigSchema } from "./config";

test("default batch command satisfies Claude print stream-json requirements", () => {
	for (const input of [
		{},
		{ agent: {} },
		{ agent: { command: "claude -p --output-format stream-json" } },
	]) {
		const args = workbenchConfigSchema.parse(input).agent.command.split(" ");
		expect(args).toContain("-p");
		expect(args).toContain("--verbose");
		expect(args.slice(args.indexOf("--output-format"))).toEqual([
			"--output-format",
			"stream-json",
		]);
	}
	const command = "custom-agent --batch";
	const config = workbenchConfigSchema.parse({ agent: { command } });
	expect(config.agent.command).toBe(command);
});
