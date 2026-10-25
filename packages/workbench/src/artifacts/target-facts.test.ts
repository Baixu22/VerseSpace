import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	targetGit as git,
	seedTargetArtifact,
} from "../test/target-artifact-fixture";
import { revalidateArtifact } from "./revalidate";
import { captureArtifactSnapshot } from "./snapshot";
import { listArtifactReviews, reconcileArtifacts } from "./status";

test("fixed file scope survives unrelated target commits while ordinary target checks stay conservative", async () => {
	for (const fixed of [true, false]) {
		const ws = await seedTargetArtifact(fixed);
		try {
			const original = (await ws.bb.checkpoints.scanZone("verified")).find(
				(cp) => cp.id === ws.checkpointId,
			)!;
			const first = (await listArtifactReviews(ws.bb)).find(
				(row) => row.rootId === ws.checkpointId,
			)!;
			expect(first.status).toBe("current");
			expect(first.targetStatus).toBe("inputs-match");
			expect(first.targetCheck).toBeUndefined();
			await writeFile(
				join(ws.projectDir, "unrelated.txt"),
				"outside check scope",
			);
			git(ws.projectDir, "add", "unrelated.txt");
			git(ws.projectDir, "commit", "-qm", "unrelated advance");
			const now = (await listArtifactReviews(ws.bb)).find(
				(row) => row.rootId === ws.checkpointId,
			)!;
			expect(now.status).toBe(fixed ? "current" : "stale");
			expect(now.targetChange).toBe(
				fixed ? "outside-declared-range" : "revalidation-required",
			);
			if (fixed) expect(now.reason).toContain("范围外");
			expect(now.targetNow?.commit).not.toBe(
				original.artifactBinding?.target?.commit,
			);
			expect(
				(await ws.bb.checkpoints.scanZone("verified")).find(
					(cp) => cp.id === ws.checkpointId,
				),
			).toEqual(original);
		} finally {
			await ws.cleanup();
		}
	}
}, 60_000);

test.each([
	"api.txt",
	"check.cjs",
	"config.json",
	"consumer.txt",
])("a target change to declared %s invalidates a source check", async (path) => {
	const ws = await seedTargetArtifact();
	try {
		await writeFile(join(ws.projectDir, path), "changed target file");
		git(ws.projectDir, "add", path);
		git(ws.projectDir, "commit", "-qm", `advance ${path}`);
		const review = (await listArtifactReviews(ws.bb)).find(
			(row) => row.rootId === ws.checkpointId,
		)!;
		expect(review.status).toBe("stale");
		expect(review.targetStatus).toBe("unknown");
		expect(review.targetChange).toBe("revalidation-required");
		expect(await readFile(join(ws.side, path), "utf8")).not.toBe(
			"changed target file",
		);
	} finally {
		await ws.cleanup();
	}
}, 60_000);

test("only explicit current-base candidate execution yields target-checked; wrong base and unreadable target stay unknown", async () => {
	const ws = await seedTargetArtifact();
	try {
		await writeFile(join(ws.projectDir, "api.txt"), "v2");
		git(ws.projectDir, "add", "api.txt");
		git(ws.projectDir, "commit", "-qm", "target input advances");
		const source = await revalidateArtifact(ws.bb, ws.checkpointId, {
			workspot: "side",
		});
		expect(source.verificationResult?.status).toBe("passed");
		expect(
			(await listArtifactReviews(ws.bb)).find(
				(row) => row.rootId === ws.checkpointId,
			)?.targetStatus,
		).toBe("inputs-differ");
		const wrong = await revalidateArtifact(ws.bb, source.id, {
			workspot: "side",
			targetCandidate: true,
		});
		expect(wrong.verificationBindingIssue).toContain("基线");
		expect(wrong.artifactTargetCheck).toBeUndefined();
		// The actual candidate workspot is on the current main base; its local
		// artifact is an explicit candidate, not a claim that main was updated.
		await writeFile(join(ws.projectDir, "consumer.txt"), "*");
		const cli = spawnSync(
			process.execPath,
			[
				resolve(import.meta.dir, "../index.ts"),
				"checkpoint",
				"revalidate",
				wrong.id,
				"--workspot",
				"ws",
				"--target-ref",
				"main",
				"--target-candidate",
				"--json",
			],
			{ cwd: ws.projectDir, encoding: "utf8" },
		);
		expect(cli.status, cli.stderr).toBe(0);
		const checked = JSON.parse(cli.stdout);
		expect(checked.artifactTargetCheck).toMatchObject({
			workspot: "ws",
			candidateHead: git(ws.projectDir, "rev-parse", "HEAD"),
			baseCommit: git(ws.projectDir, "rev-parse", "main"),
		});
		const view = (await listArtifactReviews(ws.bb)).find(
			(row) => row.rootId === ws.checkpointId,
		)!;
		expect(view.targetStatus).toBe("target-checked");
		expect(view.origin?.cwd).toBe(ws.projectDir);
		expect(view.targetCheck?.candidateCwd).toBe(ws.projectDir);
		expect(view.reason).toContain("不代表最终 ref 已合入");
		await reconcileArtifacts(ws.bb);
		const before = await ws.bb.events.all();
		await listArtifactReviews(ws.bb);
		expect(await ws.bb.events.all()).toEqual(before);
		const missing = await revalidateArtifact(ws.bb, checked.id, {
			workspot: "ws",
			targetRef: "unreadable-target",
		});
		expect(missing.artifactBinding).toBeUndefined();
		expect(
			(await listArtifactReviews(ws.bb)).find(
				(row) => row.rootId === ws.checkpointId,
			)?.status,
		).toBe("unknown");
		const snapshot = await captureArtifactSnapshot(ws.bb, missing);
		expect(snapshot?.target).toMatchObject({
			status: "unknown",
			ref: "unreadable-target",
		});
	} finally {
		await ws.cleanup();
	}
}, 60_000);
