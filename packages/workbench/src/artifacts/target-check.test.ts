import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { seedTargetArtifact, targetGit } from "../test/target-artifact-fixture";
import { revalidateArtifact } from "./revalidate";
import { listArtifactReviews, reconcileArtifacts } from "./status";

test("a checked candidate retains range evidence across outside changes and rejects altered check identity", async () => {
	const ws = await seedTargetArtifact();
	try {
		const checked = await revalidateArtifact(ws.bb, ws.checkpointId, {
			workspot: "ws",
			targetRef: "main",
			targetCandidate: true,
		});
		expect(checked.verificationBindingIssue).toBeUndefined();
		expect(
			(await listArtifactReviews(ws.bb)).find(
				(row) => row.rootId === ws.checkpointId,
			)?.targetStatus,
		).toBe("target-checked");
		const base = checked.artifactTargetCheck!.baseCommit;
		const previousCount = (
			await ws.bb.events.query({ type: "artifact_validity" })
		).filter(
			(event) =>
				(event.payload as { rootId: string }).rootId === ws.checkpointId,
		).length;
		const advancedCommits: string[] = [];
		for (let i = 0; i < 2; i++) {
			await writeFile(join(ws.projectDir, "unrelated.txt"), `outside-${i}`);
			targetGit(ws.projectDir, "add", "unrelated.txt");
			targetGit(ws.projectDir, "commit", "-qm", `outside advance ${i}`);
			advancedCommits.push(targetGit(ws.projectDir, "rev-parse", "HEAD"));
			const now = (await listArtifactReviews(ws.bb)).find(
				(row) => row.rootId === ws.checkpointId,
			)!;
			expect(now.targetStatus).toBe("target-checked");
			expect(now.targetChange).toBe("outside-declared-range");
			expect(now.targetCheck!.baseCommit).toBe(base);
			expect(now.targetNow!.commit).toBe(
				targetGit(ws.projectDir, "rev-parse", "HEAD"),
			);
			await reconcileArtifacts(ws.bb);
		}
		const observations = (
			await ws.bb.events.query({ type: "artifact_validity" })
		).filter(
			(event) =>
				(event.payload as { rootId: string }).rootId === ws.checkpointId,
		);
		expect(observations).toHaveLength(previousCount + 2);
		expect(
			observations
				.slice(previousCount)
				.map(
					(event) =>
						(event.payload as { targetNow: { commit: string } }).targetNow
							.commit,
				),
		).toEqual(advancedCommits);
		await reconcileArtifacts(ws.bb);
		expect(
			(await ws.bb.events.query({ type: "artifact_validity" })).filter(
				(event) =>
					(event.payload as { rootId: string }).rootId === ws.checkpointId,
			),
		).toEqual(observations);
		for (const altered of [
			{ ...checked.artifactTargetCheck!, objectManifestHash: "a".repeat(64) },
			{ ...checked.artifactTargetCheck!, candidateHead: "b".repeat(40) },
			{ ...checked.artifactTargetCheck!, candidateCwd: ws.side },
		]) {
			await ws.bb.checkpoints.save(
				{ ...checked, artifactTargetCheck: altered },
				"verified",
			);
			expect(
				(await listArtifactReviews(ws.bb)).find(
					(row) => row.rootId === ws.checkpointId,
				)?.targetStatus,
			).toBe("unknown");
		}
		await ws.bb.checkpoints.save(checked, "verified");
		await writeFile(join(ws.projectDir, "api.txt"), "v2");
		targetGit(ws.projectDir, "add", "api.txt");
		targetGit(ws.projectDir, "commit", "-qm", "declared input advances");
		const stale = (await listArtifactReviews(ws.bb)).find(
			(row) => row.rootId === ws.checkpointId,
		)!;
		expect(stale.status).toBe("stale");
		expect(stale.targetStatus).toBe("unknown");
		expect(stale.targetChange).toBe("revalidation-required");
	} finally {
		await ws.cleanup();
	}
}, 60_000);
