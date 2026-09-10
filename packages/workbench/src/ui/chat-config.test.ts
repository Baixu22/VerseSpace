import { expect, test } from "bun:test";
import { makeTempWorkbench } from "../test/fixtures";
import { createUiServer } from "./server";

test("choosing default effort clears the saved choice without changing other settings", async () => {
	const workspace = await makeTempWorkbench();
	const config = await workspace.bb.config.load();
	config.chat = {
		...config.chat,
		provider: "openai-responses",
		model: "kept-model",
		effort: "high",
	};
	await workspace.bb.config.save(config);
	const server = await createUiServer(workspace.bb, 0);
	try {
		const response = await fetch(
			`http://127.0.0.1:${server.port}/api/config/chat`,
			{
				method: "PATCH",
				headers: {
					"x-workbench-token": server.authToken,
					"content-type": "application/json",
				},
				body: JSON.stringify({ effort: null }),
			},
		);
		expect(response.ok).toBe(true);
		const saved = (await workspace.bb.config.load()).chat;
		expect(saved.effort).toBeUndefined();
		expect(saved.provider).toBe("openai-responses");
		expect(saved.model).toBe("kept-model");
		expect(await response.json()).not.toHaveProperty("effort");
	} finally {
		server.stop(true);
		await workspace.cleanup();
	}
});
