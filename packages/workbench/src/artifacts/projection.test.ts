import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildBranchL1Summary } from "../chat/resume-card/l1-summary";
import { ChatThreads } from "../chat/threads";
import { findMcpTool, MCP_TOOLS } from "../mcp/tools";
import { makeTempWorkbench } from "../test/fixtures";
import { seedPortableArtifact } from "../test/manifest-fixture";
import { createUiServer } from "../ui/server";
import { artifactReviewProjection, projectArtifactReviews } from "./projection";
import { listArtifactReviews } from "./status";

test.each([
	"current",
	"stale",
	"unknown",
] as const)("CLI, read-only MCP and real restore HTTP agree for %s", async (status) => {
	const ws = await seedPortableArtifact();
	const chat = new ChatThreads(ws.bb);
	const thread = await chat.create("artifact projection");
	const root = (await ws.bb.checkpoints.scanZone("verified"))[0]!;
	const cp = { ...root, threadId: thread.id };
	await ws.bb.checkpoints.save(cp, "verified");
	const server = await createUiServer(ws.bb, 0, undefined, {
		reconcileIntervalMs: 60_000,
	});
	try {
		if (status === "stale")
			await writeFile(join(ws.projectDir, "api.txt"), "v2");
		if (status === "unknown")
			await ws.bb.checkpoints.save(
				{ ...cp, verificationBinding: undefined },
				"verified",
			);
		const before = await ws.bb.checkpoints.scanAll();
		const events = await ws.bb.events.all();
		const view = await artifactReviewProjection(ws.bb, thread.id);
		expect(view.items[0]?.status).toBe(status);
		expect(view.items[0]?.facts.origin.strength).toBe("tool-observed");
		expect(view.items[0]?.facts.verification.result).toBe("passed");
		if (status === "stale")
			expect(view.items[0]?.facts.inputs.status).toBe("different");
		const cli = spawnSync(
			process.execPath,
			[
				resolve(import.meta.dir, "../index.ts"),
				"checkpoint",
				"list",
				"--artifact-view",
				"--writer",
				thread.id,
				"--json",
			],
			{ cwd: ws.projectDir, encoding: "utf8" },
		);
		expect(cli.status, cli.stderr).toBe(0);
		expect(JSON.parse(cli.stdout)).toEqual(view);
		const mcp = await findMcpTool("resume_cards")!.run(
			{ threadId: thread.id, view: "artifacts" },
			ws.bb,
		);
		expect(mcp.length).toBeLessThanOrEqual(2000);
		expect(JSON.parse(mcp)).toEqual(view);
		const response = await fetch(
			`http://127.0.0.1:${server.port}/api/chat/threads/${thread.id}`,
			{ headers: { "x-workbench-token": server.authToken } },
		);
		expect(response.status).toBe(200);
		expect((await response.json()).artifactReviews).toEqual(view);
		const branch = await buildBranchL1Summary({
			bb: ws.bb,
			branch: { id: thread.id, title: thread.title },
			events,
			isAfterLeave: () => true,
			counterpartyWrites: new Set(),
		});
		const line = branch.lines.find((entry) =>
			entry.text.includes("产物 consumer.txt"),
		)!;
		expect(line.text).toContain(status);
		expect(line.text).toContain("tool-observed");
		expect(line.refs).toEqual(view.items[0]!.refs);
		expect(await ws.bb.checkpoints.scanAll()).toEqual(before);
		expect(await ws.bb.events.all()).toEqual(events);
		expect(MCP_TOOLS.map((tool) => tool.name)).toEqual([
			"premises",
			"footprints",
			"resume_cards",
			"tribunal",
			"notices",
		]);
	} finally {
		await server.stop(true);
		await ws.cleanup();
	}
}, 60_000);

test("bounded display keeps every status count and total, and command IDs are quoted for Windows", async () => {
	const ws = await seedPortableArtifact();
	try {
		const item = (await listArtifactReviews(ws.bb))[0]!;
		const states = [
			"current",
			"stale",
			"pending",
			"failed",
			"unknown",
		] as const;
		const reviews = Array.from({ length: 100 }, (_, i) => ({
			...item,
			rootId: `root-${i}`,
			checkpointId: `cp-${i}`,
			status: states[i % states.length]!,
		}));
		const view = projectArtifactReviews(reviews);
		expect(JSON.stringify(view).length).toBeLessThanOrEqual(2000);
		expect(view.total).toBe(100);
		expect(view.counts).toEqual({
			current: 20,
			stale: 20,
			pending: 20,
			failed: 20,
			unknown: 20,
		});
		expect(view.omitted + view.items.length).toBe(100);
		expect(view.truncated).toBe(true);
		const paths = ["a", "b", "c", "d"];
		const inputPreview = projectArtifactReviews([
			{
				...item,
				inputs: paths,
				facts: {
					...item.facts!,
					inputs: {
						status: "different",
						versions: Object.fromEntries(
							paths.map((path) => [path, "a".repeat(64)]),
						),
						changed: paths,
					},
				},
			},
		]);
		expect(inputPreview.items[0]!.facts.inputs).toMatchObject({
			total: 4,
			changedTotal: 4,
			status: "different",
			previewTruncated: true,
		});
		expect(inputPreview.items[0]!.facts.inputs.versions).toHaveLength(3);
		const quoted = projectArtifactReviews([
			{ ...item, checkpointId: "cp'; $danger" },
		]);
		expect(quoted.items[0]!.revalidateCommand).toBe(
			"workbench checkpoint revalidate 'cp''; $danger'",
		);
		expect(quoted.items[0]!.status).toBe("current");
	} finally {
		await ws.cleanup();
	}
}, 60_000);

test("old empty thread has an explicit zero artifact projection and stays read-only", async () => {
	const ws = await makeTempWorkbench();
	try {
		const thread = await new ChatThreads(ws.bb).create("legacy");
		const events = await ws.bb.events.all();
		const view = await artifactReviewProjection(ws.bb, thread.id);
		expect(view).toMatchObject({
			total: 0,
			items: [],
			omitted: 0,
			truncated: false,
		});
		expect(
			JSON.parse(
				await findMcpTool("resume_cards")!.run(
					{ threadId: thread.id, view: "artifacts" },
					ws.bb,
				),
			),
		).toEqual(view);
		expect(await ws.bb.events.all()).toEqual(events);
	} finally {
		await ws.cleanup();
	}
});
