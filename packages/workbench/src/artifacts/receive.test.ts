import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { captureReturnedInput } from "../blackboard/footprint-sample";
import { seedPortableArtifact } from "../test/manifest-fixture";
import { targetGit } from "../test/target-artifact-fixture";
import { checkpointSchema } from "../types/checkpoint";
import { workspotSchema } from "../types/workspot";
import { selectArtifactInputs } from "./input-origin";
import { exportArtifactManifest } from "./manifest";
import { stableManifestJson } from "./manifest-codec";
import { receiveArtifactManifest } from "./receive";
import { revalidateArtifact } from "./revalidate";
import { captureArtifactSnapshot } from "./snapshot";

async function seedReceiver() {
	const ws = await seedPortableArtifact();
	const source = (await ws.bb.checkpoints.scanZone("verified"))[0]!;
	const manifest = await exportArtifactManifest(ws.bb, source.id);
	const receiver = join(ws.projectDir, "receiver");
	targetGit(ws.projectDir, "worktree", "add", "--detach", receiver, "HEAD");
	await ws.bb.state.workspots.save(
		workspotSchema.parse({
			id: "receiver",
			branch: "receiver",
			worktreePath: receiver,
			status: "active",
			primaryTask: source.goal,
		}),
	);
	await ws.bb.sessions.register("receiver-writer", "agent");
	await ws.bb.sessions.recordActivity("receiver-writer", {
		activity: "read",
		agent: "receiver-writer",
		generated: [],
		used: [
			await captureReturnedInput(ws.projectDir, join(receiver, "api.txt"), {
				returned: "v1",
				content: "v1",
				selector: { kind: "file" },
			}),
		],
	});
	const policy = checkpointSchema.parse({
		...source,
		id: "receiver-policy",
		lifecycle: "draft",
		workspot: "receiver",
		writerId: "receiver-writer",
		artifact: {
			...source.artifact!,
			inputRecords: [
				{ path: "api.txt", writerId: "receiver-writer", footprintSeq: 1 },
			],
		},
		verificationResult: undefined,
		verificationBinding: undefined,
		artifactBinding: undefined,
		artifactOrigin: undefined,
		artifactInputOrigin: undefined,
	});
	policy.artifactOrigin = await captureArtifactSnapshot(ws.bb, policy);
	policy.artifactInputOrigin = await selectArtifactInputs(ws.bb, policy);
	await ws.bb.checkpoints.save(policy, "staging");
	const report = await readFile(
		join(
			ws.bb.paths.checkpoints,
			"objects",
			source.verificationResult!.object!.reportFile!,
		),
	);
	await writeFile(join(receiver, "sender-report.json"), report);
	const text = stableManifestJson(manifest);
	await writeFile(join(ws.projectDir, "incoming-manifest.json"), text);
	return {
		...ws,
		source,
		policy,
		manifest,
		receiver,
		report,
		text,
		options: {
			checkpoint: policy.id,
			workspot: "receiver",
			report: "sender-report.json",
		},
	};
}

test("explicit receiver root maps identical content and runs only its existing local policy without replaying effects", async () => {
	const ws = await seedReceiver();
	try {
		const before = await ws.bb.checkpoints.scanAll();
		const events = await ws.bb.events.all();
		const matched = await receiveArtifactManifest(ws.bb, ws.text, ws.options);
		expect(matched.status).toBe("matched");
		expect(matched.refs).toContain(ws.manifest.digest);
		expect(await ws.bb.checkpoints.scanAll()).toEqual(before);
		expect(await ws.bb.events.all()).toEqual(events);
		await expect(
			revalidateArtifact(ws.bb, ws.policy.id, {
				workspot: "receiver",
				expectedCwd: ws.projectDir,
			}),
		).rejects.toThrow("切换目录");
		await expect(
			revalidateArtifact(ws.bb, ws.policy.id, {
				workspot: "receiver",
				expectedPolicy: {
					artifact: ws.source.artifact,
					verification: ws.source.verification,
				},
			}),
		).rejects.toThrow("检查声明");
		expect(await ws.bb.checkpoints.scanAll()).toEqual(before);
		expect(await ws.bb.events.all()).toEqual(events);
		const cli = spawnSync(
			process.execPath,
			[
				resolve(import.meta.dir, "../index.ts"),
				"checkpoint",
				"receive",
				"incoming-manifest.json",
				"--checkpoint",
				ws.policy.id,
				"--workspot",
				"receiver",
				"--report",
				"sender-report.json",
				"--revalidate",
				"--json",
			],
			{ cwd: ws.projectDir, encoding: "utf8" },
		);
		expect(cli.status, `${cli.stderr}\n${cli.stdout}`).toBe(0);
		const checked = JSON.parse(cli.stdout);
		expect(checked.status).toBe("locally-checked");
		const all = Object.values(await ws.bb.checkpoints.scanAll()).flat();
		const own = all.find((cp) => cp.id === checked.checkedCheckpointId)!;
		expect(own.artifactHandoff).toEqual(ws.manifest);
		expect(own.artifactInputOrigin).toEqual(ws.policy.artifactInputOrigin);
		expect(own.artifactInputOrigin?.reads[0]?.writerId).toBe("receiver-writer");
		expect(own.verificationResult?.object?.sourceCwd).toBe(ws.receiver);
		expect(own.blackboardEffects.update).toEqual([]);
		expect(all.find((cp) => cp.id === ws.source.id)).toEqual(ws.source);
		expect(all.find((cp) => cp.id === ws.policy.id)).toEqual(ws.policy);
		expect((await ws.bb.interfaces.getEntry("acceptance"))?.publishedBy).toBe(
			"before",
		);
		expect(await ws.bb.events.query({ type: "checkpoint_applied" })).toEqual(
			[],
		);
	} finally {
		await ws.cleanup();
	}
}, 60_000);

test("receiver separately refuses file, report, target and unsupported manifest changes", async () => {
	const ws = await seedReceiver();
	try {
		const before = await ws.bb.checkpoints.scanAll();
		const events = await ws.bb.events.all();
		for (const path of [
			"api.txt",
			"consumer.txt",
			"config.json",
			"check.cjs",
		]) {
			const prior = await readFile(join(ws.receiver, path));
			await writeFile(join(ws.receiver, path), "changed");
			const changed = await receiveArtifactManifest(ws.bb, ws.text, ws.options);
			expect(changed.status).toBe("revalidation-required");
			expect(changed.changedFiles).toContain(path);
			await writeFile(join(ws.receiver, path), prior);
		}
		await ws.bb.checkpoints.save(
			{
				...ws.policy,
				verification: {
					...ws.policy.verification!,
					command: "untrusted-command",
				},
			},
			"staging",
		);
		expect(
			(
				await receiveArtifactManifest(ws.bb, ws.text, {
					...ws.options,
					revalidate: true,
				})
			).status,
		).toBe("rejected");
		await ws.bb.checkpoints.save(ws.policy, "staging");
		await writeFile(
			join(ws.receiver, "sender-report.json"),
			ws.report.toString().replace('"contract"', '"another-case"'),
		);
		expect(
			(await receiveArtifactManifest(ws.bb, ws.text, ws.options)).status,
		).toBe("revalidation-required");
		await writeFile(join(ws.receiver, "sender-report.json"), "{");
		expect(
			(await receiveArtifactManifest(ws.bb, ws.text, ws.options)).status,
		).toBe("unknown");
		await writeFile(join(ws.receiver, "sender-report.json"), ws.report);
		for (const text of [
			"{",
			JSON.stringify({ ...ws.manifest, schemaVersion: 2 }),
			JSON.stringify({ ...ws.manifest, command: "malicious" }),
			JSON.stringify({ ...ws.manifest, digest: "a".repeat(64) }),
		])
			expect(
				(
					await receiveArtifactManifest(ws.bb, text, {
						...ws.options,
						revalidate: true,
					})
				).status,
			).toBe("unknown");
		await writeFile(join(ws.projectDir, "unrelated.txt"), "advanced");
		targetGit(ws.projectDir, "add", "unrelated.txt");
		targetGit(ws.projectDir, "commit", "-qm", "advance target");
		const advance = await receiveArtifactManifest(ws.bb, ws.text, ws.options);
		expect(advance.status).toBe("revalidation-required");
		expect(advance.reasons).toContain("local-target-advanced-or-different");
		targetGit(ws.projectDir, "branch", "-m", "main", "hidden-main");
		expect(
			(await receiveArtifactManifest(ws.bb, ws.text, ws.options)).status,
		).toBe("unknown");
		expect(await ws.bb.checkpoints.scanAll()).toEqual(before);
		expect(await ws.bb.events.all()).toEqual(events);
	} finally {
		await ws.cleanup();
	}
}, 60_000);

test("a receiver recheck creates failed evidence when its own contract fails", async () => {
	const ws = await seedReceiver();
	try {
		await writeFile(join(ws.receiver, "api.txt"), "v2");
		const result = await receiveArtifactManifest(ws.bb, ws.text, {
			...ws.options,
			revalidate: true,
		});
		expect(result.status).toBe("failed");
		expect(result.localCheck).toMatchObject({ result: "failed", exitCode: 1 });
		expect(result.checkedCheckpointId).toBeTruthy();
		const failed = (await ws.bb.checkpoints.scanZone("failed")).find(
			(cp) => cp.id === result.checkedCheckpointId,
		)!;
		expect(failed.verificationResult?.status).toBe("failed");
		expect(failed.artifactHandoff).toEqual(ws.manifest);
		expect(failed.artifactInputOrigin).toEqual(ws.policy.artifactInputOrigin);
		expect(await ws.bb.events.query({ type: "checkpoint_applied" })).toEqual(
			[],
		);
	} finally {
		await ws.cleanup();
	}
}, 60_000);
