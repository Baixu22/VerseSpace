/**
 * Real-model adapter for `workbench agent run` (issue #11).
 * The runner sends plain text; the shared live actor defaults to stream-json.
 * Credentials stay in process memory. Only an explicit live fixture may run.
 */
import { assertLiveAuthorized } from "./live-auth";
import { loadLiveModelCredentials } from "./live-credentials";

async function main(): Promise<void> {
	await assertLiveAuthorized(process.cwd());
	const credentials = loadLiveModelCredentials();
	process.env.E2E_LLM_KEY = credentials.key;
	process.env.E2E_LLM_MODEL = credentials.model;
	process.env.E2E_LLM_BASE_URL = credentials.baseUrl;
	process.argv.push("--input-format", "text");
	await import("./live-agent");
}

main().catch(() => {
	process.stderr.write(
		"agent-run-live 启动失败：检查隔离工作区标记和模型凭据。\n",
	);
	process.exitCode = 1;
});
