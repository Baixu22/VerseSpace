import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { verifyCheckpoint } from "../runtime/verify-checkpoint";
import { seedArtifactUse } from "../test/artifact-use-fixture";
import { targetGit } from "../test/target-artifact-fixture";
import {
	type ArtifactManifest,
	artifactManifestSchema,
	manifestPathSchema,
} from "../types/artifact-manifest";
import { exportArtifactManifest } from "./manifest";
import {
	assessArtifactManifest,
	decodeArtifactManifest,
	sealArtifactManifest,
	stableManifestJson,
} from "./manifest-codec";

async function seedManifest() {
	const ws = await seedArtifactUse();
	await writeFile(
		join(ws.projectDir, ".gitignore"),
		".workbench/\nreport.json\nmanifest.json\n",
	);
	await writeFile(
		join(ws.projectDir, "config.json"),
		'{"apiKey":"SENTINEL_SECRET_CONFIG"}',
	);
	targetGit(
		ws.projectDir,
		"add",
		".gitignore",
		"api.txt",
		"consumer.txt",
		"check.cjs",
		"config.json",
	);
	targetGit(ws.projectDir, "commit", "-qm", "manifest baseline");
	const root = (await ws.bb.checkpoints.scanZone("verified"))[0]!;
	const draft = {
		...root,
		lifecycle: "draft" as const,
		assertion: "SENTINEL_SECRET_ASSERTION",
		artifact: { ...root.artifact!, targetRef: "main" },
		verification: {
			...root.verification!,
			command: undefined,
			evidence: {
				...root.verification!.evidence!,
				inputs: ["config.json"],
				fixedFiles: {
					mode: "node-offline-files-v1" as const,
					complete: true as const,
					script: "check.cjs",
				},
			},
		},
	};
	await ws.bb.checkpoints.save(draft, "staging");
	await verifyCheckpoint(ws.bb, "cp", []);
	return ws;
}

test("real fixed check exports stable portable evidence, exact report and source identities without writing ledger", async () => {
	const ws = await seedManifest();
	try {
		const before = await ws.bb.checkpoints.scanAll();
		const events = await ws.bb.events.all();
		const manifest = await exportArtifactManifest(ws.bb, "cp");
		expect(assessArtifactManifest(manifest).status).toBe(
			"bound-scope-evidence",
		);
		expect(manifest.origin.reads[0]).toMatchObject({
			path: "api.txt",
			source: "tool-observed",
			binding: "matched",
			footprintSeq: 1,
		});
		expect(manifest.target.status).toBe("inputs-match");
		expect(manifest.target.candidate).toBeNull();
		expect(
			manifest.verification.object?.files.map((file) => file.path),
		).toEqual(["api.txt", "check.cjs", "config.json", "consumer.txt"]);
		const serialized = stableManifestJson(manifest);
		expect(serialized).toBe(
			stableManifestJson(await exportArtifactManifest(ws.bb, "cp")),
		);
		for (const secret of [
			ws.projectDir,
			"SENTINEL_SECRET",
			"sourceCwd",
			"executedCwd",
			"recordPath",
			"blackboardEffects",
			'"command":',
			"apiKey",
		])
			expect(serialized).not.toContain(secret);
		expect(decodeArtifactManifest(serialized)).toEqual({
			status: "valid",
			manifest,
		});
		const cli = spawnSync(
			process.execPath,
			[
				resolve(import.meta.dir, "../index.ts"),
				"checkpoint",
				"export",
				"cp",
				"--output",
				"manifest.json",
				"--json",
			],
			{ cwd: ws.projectDir, encoding: "utf8" },
		);
		expect(cli.status, cli.stderr).toBe(0);
		expect(JSON.parse(cli.stdout).manifest).toEqual(manifest);
		expect(
			decodeArtifactManifest(
				await readFile(join(ws.projectDir, "manifest.json"), "utf8"),
			),
		).toEqual({ status: "valid", manifest });
		expect(await ws.bb.checkpoints.scanAll()).toEqual(before);
		expect(await ws.bb.events.all()).toEqual(events);
		const repeat = spawnSync(
			process.execPath,
			[
				resolve(import.meta.dir, "../index.ts"),
				"checkpoint",
				"export",
				"cp",
				"--output",
				"manifest.json",
				"--quiet",
			],
			{ cwd: ws.projectDir, encoding: "utf8" },
		);
		expect(repeat.status).toBe(1);
		expect(await readFile(join(ws.projectDir, "manifest.json"), "utf8")).toBe(
			`${serialized}\n`,
		);
		const cp = (await ws.bb.checkpoints.scanZone("verified"))[0]!;
		await ws.bb.checkpoints.save(
			{ ...cp, artifact: { ...cp.artifact!, targetRef: "unreadable-target" } },
			"verified",
		);
		const unknown = await exportArtifactManifest(ws.bb, "cp");
		expect(unknown.verification.result).toBe("passed");
		expect(unknown.target).toMatchObject({
			status: "unknown",
			ref: "unreadable-target",
			baseRef: "main",
			currentRef: "unreadable-target",
		});
		expect(assessArtifactManifest(unknown).status).toBe("insufficient");
	} finally {
		await ws.cleanup();
	}
}, 60_000);

test("manifest decoder and assessment reject tampering, unknown basis and false passed labels", async () => {
	const ws = await seedManifest();
	try {
		const original = await exportArtifactManifest(ws.bb, "cp");
		const mutations: Array<(m: ArtifactManifest) => void> = [
			(m) => {
				m.scope.complete = false;
			},
			(m) => {
				m.scope.expectedTests.push("absent-case");
			},
			(m) => {
				m.origin.reads = [];
			},
			(m) => {
				m.origin.locallyMatched = false;
			},
			(m) => {
				m.origin.reads[0]!.binding = "unknown";
			},
			(m) => {
				m.target.status = "unknown";
			},
			(m) => {
				m.target.status = "target-checked";
			},
			(m) => {
				m.target.currentRef = "another-ref";
			},
			(m) => {
				m.target.currentCommit = "a".repeat(40);
			},
			(m) => {
				m.target.currentBlobs[0]!.hash = "b".repeat(40);
			},
			(m) => {
				m.verification.reportHash = "a".repeat(64);
			},
			(m) => {
				m.verification.object!.files.pop();
			},
			(m) => {
				m.artifact.hash = "b".repeat(64);
			},
			(m) => {
				m.inputs[0]!.checkedHash = "c".repeat(64);
			},
			(m) => {
				m.verification.current = "stale";
			},
			(m) => {
				m.verification.authority = "human";
			},
		];
		for (const mutate of mutations) {
			const modified = structuredClone(original);
			mutate(modified);
			expect(decodeArtifactManifest(JSON.stringify(modified)).status).toBe(
				"unknown",
			);
			const { digest: _digest, ...body } = modified;
			const sealed = sealArtifactManifest(body);
			expect(decodeArtifactManifest(stableManifestJson(sealed)).status).toBe(
				"valid",
			);
			expect(assessArtifactManifest(sealed).status).toBe("insufficient");
		}
		for (const broken of [
			{ ...original, schemaVersion: 2 },
			{ ...original, origin: undefined },
			{ ...original, command: "run arbitrary script" },
		])
			expect(decodeArtifactManifest(JSON.stringify(broken))).toEqual({
				status: "unknown",
				reason: "unsupported-schema",
			});
		expect(decodeArtifactManifest("{")).toMatchObject({ status: "unknown" });
		expect(decodeArtifactManifest(" ".repeat(1_000_001))).toEqual({
			status: "unknown",
			reason: "size-limit",
		});
		const reordered = Object.fromEntries(Object.entries(original).reverse());
		const large = structuredClone(original);
		const path = "p".repeat(512);
		large.inputs = Array.from({ length: 128 }, () => ({
			...large.inputs[0]!,
			path,
		}));
		large.origin.reads = Array.from({ length: 128 }, () => ({
			...large.origin.reads[0]!,
			path,
		}));
		large.scope.configPaths = Array(128).fill(path);
		large.scope.expectedTests = Array(512).fill(path);
		large.verification.actualTests = Array.from({ length: 512 }, () => ({
			name: path,
			status: "passed",
		}));
		large.verification.object!.files = Array.from({ length: 128 }, () => ({
			...large.verification.object!.files[0]!,
			path,
		}));
		large.target.blobs = Array.from({ length: 128 }, () => ({
			...large.target.blobs[0]!,
			path,
		}));
		large.target.currentBlobs = structuredClone(large.target.blobs);
		const { digest: _largeDigest, ...largeBody } = large;
		expect(() => sealArtifactManifest(largeBody)).toThrow("1 MB");
		expect(stableManifestJson(reordered)).toBe(stableManifestJson(original));
		expect(decodeArtifactManifest(JSON.stringify(reordered)).status).toBe(
			"valid",
		);
	} finally {
		await ws.cleanup();
	}
}, 60_000);

test("portable path rules refuse host paths and ambiguous file identities", () => {
	for (const path of [
		"C:/Users/private.txt",
		"C:\\Users\\private.txt",
		"/tmp/private",
		"../private",
		"./file",
		"a/../b",
		"a//b",
		"file:stream",
		"file\0",
		"\\\\server\\file",
	])
		expect(manifestPathSchema.safeParse(path).success).toBe(false);
	expect(manifestPathSchema.safeParse("src/config.json").success).toBe(true);
	expect(artifactManifestSchema.safeParse({ schemaVersion: 1 }).success).toBe(
		false,
	);
});
