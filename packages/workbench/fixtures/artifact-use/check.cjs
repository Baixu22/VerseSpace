// Controlled offline contract, executed by a real child process in each group.
const fs = require("node:fs");
const spec = JSON.parse(fs.readFileSync("case.json", "utf8"));
const original = fs.readFileSync("api.txt", "utf8");
if (spec.transient && !process.env.ARTIFACT_FIXED_COPY)
	fs.writeFileSync("api.txt", spec.transient);
const actual = fs.readFileSync("api.txt", "utf8");
const consumer = fs.readFileSync("consumer.txt", "utf8");
const ok = consumer === "*" || actual === consumer;
const names =
	spec.report === "zero"
		? []
		: spec.report === "subset"
			? ["contract input"]
			: ["contract input", "contract consumer"];
const tests = names.map((fullName) => ({
	fullName,
	status: ok ? "passed" : "failed",
}));
fs.writeFileSync(
	"report.json",
	spec.report === "broken"
		? "{"
		: JSON.stringify({
				numTotalTests: tests.length,
				numPassedTests: ok ? tests.length : 0,
				numFailedTests: ok ? 0 : tests.length,
				numPendingTests: 0,
				success: ok,
				testResults: [{ assertionResults: tests }],
			}),
);
if (spec.transient && !process.env.ARTIFACT_FIXED_COPY)
	fs.writeFileSync("api.txt", original);
process.exitCode = ok ? 0 : 1;
