import { hashText } from "../hash";
import {
	type ArtifactManifest,
	artifactManifestBodySchema,
	artifactManifestSchema,
} from "../types/artifact-manifest";
import { verificationObjectDigest } from "../verifier/isolated-files";

/** JSON object key order is irrelevant; array order is retained as part of the declaration. */
export function stableManifestJson(value: unknown): string {
	return JSON.stringify(value, (_key, item) =>
		item && typeof item === "object" && !Array.isArray(item)
			? Object.fromEntries(
					Object.keys(item)
						.sort()
						.map((key) => [key, item[key]]),
				)
			: item,
	);
}

export function sealArtifactManifest(body: unknown): ArtifactManifest {
	const parsed = artifactManifestBodySchema.parse(body);
	const manifest = { ...parsed, digest: hashText(stableManifestJson(parsed)) };
	if (Buffer.byteLength(stableManifestJson(manifest)) > 1_000_000)
		throw new Error("证据清单超过 1 MB 上限");
	return manifest;
}

export function decodeArtifactManifest(text: string):
	| { status: "valid"; manifest: ArtifactManifest }
	| {
			status: "unknown";
			reason: "size-limit" | "unsupported-schema" | "digest-mismatch";
	  } {
	if (Buffer.byteLength(text) > 1_000_000)
		return { status: "unknown", reason: "size-limit" };
	try {
		const manifest = artifactManifestSchema.parse(JSON.parse(text));
		const { digest, ...body } = manifest;
		if (digest !== hashText(stableManifestJson(body)))
			return { status: "unknown", reason: "digest-mismatch" };
		return { status: "valid", manifest };
	} catch {
		return { status: "unknown", reason: "unsupported-schema" };
	}
}

/** Recompute the boundary, never accept a sender's `passed` boolean as authorization. */
export function assessArtifactManifest(manifest: ArtifactManifest) {
	const issues: string[] = [];
	const {
		artifact,
		inputs,
		origin,
		scope,
		verification: check,
		target,
	} = manifest;
	const object = check.object;
	const names = inputs.map((input) => input.path);
	if (
		new Set(names).size !== names.length ||
		!artifact.hash ||
		inputs.some((input) => !input.checkedHash)
	)
		issues.push("missing-file-basis");
	if (
		!origin.locallyMatched ||
		origin.strength !== "tool-observed" ||
		names.some(
			(path) =>
				!origin.reads.some(
					(read) =>
						read.path === path &&
						read.source === "tool-observed" &&
						read.binding !== "unknown" &&
						read.contentHash &&
						read.returnedHash,
				),
		)
	)
		issues.push("insufficient-origin");
	if (
		!scope.complete ||
		scope.mode !== "node-offline-files-v1" ||
		!object ||
		!scope.script
	)
		issues.push("scope-not-closed");
	if (object) {
		const declared = [
			...new Set([
				artifact.path,
				...names,
				...scope.configPaths,
				...(scope.script ? [scope.script] : []),
			]),
		].sort();
		if (
			JSON.stringify(declared) !==
				JSON.stringify(object.files.map((file) => file.path)) ||
			object.script !== scope.script ||
			object.reportPath !== scope.reportPath ||
			object.manifestHash !== verificationObjectDigest(object) ||
			object.copyBytes !==
				object.files.reduce((sum, file) => sum + file.bytes, 0) ||
			object.files.find((file) => file.path === artifact.path)?.hash !==
				artifact.hash ||
			inputs.some(
				(input) =>
					object.files.find((file) => file.path === input.path)?.hash !==
					input.checkedHash,
			)
		)
			issues.push("object-binding-mismatch");
	}
	const tests = check.actualTests;
	if (
		new Set(scope.expectedTests).size !== scope.expectedTests.length ||
		new Set(tests.map((test) => test.name)).size !== tests.length ||
		tests.length !== scope.expectedTests.length ||
		scope.expectedTests.some(
			(name) =>
				!tests.some((test) => test.name === name && test.status === "passed"),
		) ||
		check.counts.total !== tests.length ||
		check.counts.passed !== tests.length ||
		check.counts.failed !== 0 ||
		check.counts.skipped !== 0 ||
		check.result !== "passed" ||
		check.current !== "current" ||
		check.authority !== "command" ||
		check.exitCode !== 0 ||
		check.scopeStatus !== "satisfied" ||
		!check.reportHash ||
		object?.reportHash !== check.reportHash
	)
		issues.push("check-not-bound");
	if (
		!target.ref ||
		target.ref !== target.baseRef ||
		target.ref !== target.currentRef ||
		!target.baseCommit ||
		!target.baseTree ||
		!target.currentCommit ||
		!target.currentTree ||
		target.status === "unknown" ||
		target.status === "inputs-differ" ||
		(target.change !== "none" && target.change !== "outside-declared-range")
	)
		issues.push("target-not-established");
	if (
		scope.mode === "node-offline-files-v1" &&
		object &&
		(JSON.stringify(target.blobs.map((file) => file.path)) !==
			JSON.stringify(object.files.map((file) => file.path)) ||
			stableManifestJson(target.blobs) !==
				stableManifestJson(target.currentBlobs) ||
			(target.change === "none" &&
				(target.baseCommit !== target.currentCommit ||
					target.baseTree !== target.currentTree)))
	)
		issues.push("target-range-mismatch");
	if (
		target.status === "target-checked" &&
		(!target.candidate ||
			target.candidate.head !== target.baseCommit ||
			target.candidate.head !== manifest.context.head ||
			target.candidate.workspotHash !== manifest.context.workspotHash ||
			target.candidate.objectHash !== object?.manifestHash)
	)
		issues.push("candidate-not-bound");
	return {
		status: issues.length
			? ("insufficient" as const)
			: ("bound-scope-evidence" as const),
		issues,
		limitations: manifest.limitations,
	};
}
