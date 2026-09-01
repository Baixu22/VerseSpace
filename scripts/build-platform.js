import { posix, win32 } from "node:path";

export const TARGET_TRIPLE_ENV_KEYS = Object.freeze([
	"TAURI_TARGET_TRIPLE",
	"TAURI_ENV_TARGET_TRIPLE",
	"CARGO_BUILD_TARGET",
]);

export const MACOS_RELEASE_TARGETS = Object.freeze([
	Object.freeze({
		os: "macos",
		arch: "arm64",
		targetTriple: "aarch64-apple-darwin",
		tauriArgs: "--target aarch64-apple-darwin",
		updaterPlatformKey: "darwin-aarch64",
	}),
	Object.freeze({
		os: "macos",
		arch: "x64",
		targetTriple: "x86_64-apple-darwin",
		tauriArgs: "--target x86_64-apple-darwin",
		updaterPlatformKey: "darwin-x86_64",
	}),
]);

export function targetTripleFromEnv(env = process.env) {
	for (const key of TARGET_TRIPLE_ENV_KEYS) {
		const value = env[key]?.trim();
		if (value) return value;
	}
	return undefined;
}

export function resolveTargetTriple(options = {}) {
	const fromEnv = targetTripleFromEnv(options.env ?? process.env);
	if (fromEnv) return fromEnv;

	const hostTriple =
		typeof options.readHostTriple === "function"
			? options.readHostTriple()
			: options.hostTriple;
	const trimmed = hostTriple?.trim();
	if (!trimmed) {
		throw new Error("Unable to resolve target triple");
	}
	return trimmed;
}

export function cliBinaryNameForPlatform(platform = process.platform) {
	return platform === "win32" ? "helmor-cli.exe" : "helmor-cli";
}

function platformPath(platform) {
	return platform === "win32" ? win32 : posix;
}

export function resolveBundleArtifacts(options) {
	const platform = options.platform ?? process.platform;
	// Build paths for the target platform, not for the host running the
	// planner. Cross-platform tests and macOS release planning run on Windows
	// in CI/dev environments, but their artifact paths must remain POSIX.
	const path = platformPath(platform);
	const repoRoot = path.resolve(options.repoRoot);
	const targetTriple = options.targetTriple;
	const profile = options.profile ?? "release";
	const sidecarDir = path.resolve(repoRoot, "sidecar");
	const srcTauriDir = path.resolve(repoRoot, "src-tauri");
	// Bun's `--compile` and cargo both append `.exe` on Windows, and Tauri's
	// `externalBin` resolution expects the `-<triple>` artifacts to carry it too.
	const exe = platform === "win32" ? ".exe" : "";
	const cliBinaryName = cliBinaryNameForPlatform(platform);
	const cliSource =
		profile === "release"
			? path.resolve(
					srcTauriDir,
					"target",
					targetTriple,
					"release",
					cliBinaryName,
				)
			: path.resolve(srcTauriDir, "target", "debug", cliBinaryName);

	return {
		targetTriple,
		profile,
		sidecarSource: path.resolve(sidecarDir, "dist", `helmor-sidecar${exe}`),
		sidecarExternalBin: path.resolve(
			sidecarDir,
			"dist",
			`helmor-sidecar-${targetTriple}${exe}`,
		),
		cliSource,
		cliExternalBin: path.resolve(
			srcTauriDir,
			"target",
			"bundled",
			`helmor-cli-${targetTriple}${exe}`,
		),
	};
}
