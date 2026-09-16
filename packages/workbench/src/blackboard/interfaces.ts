import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { BlackboardConflictError, BlackboardDataError } from "../errors";
import { pathExists, safeReaddir } from "../fs/atomic";
import { withPidLock } from "../fs/lockfile";
import { hashFile } from "../hash";
import type { WorkbenchPaths } from "../paths";
import {
	type RegistryEntry,
	type RegistryUpdate,
	registryEntrySchema,
	registrySchema,
	registryUpdateSchema,
	type Subscriber,
} from "../types/interface-registry";
import { readYamlFile, writeYamlFile } from "../yamlio";

export interface DriftReport {
	key: string;
	drifted: boolean;
	registeredHash: string;
	currentHash: string | null;
	missing: boolean;
}

export interface UpdateVersionOptions {
	/**
	 * CAS precondition: the update only lands when the stored version still
	 * matches. On mismatch the write fails with `BlackboardConflictError`
	 * carrying the current entry instead of silently overwriting it.
	 */
	expectedVersion?: number;
}

/** Interface keys may contain any characters; file names may not. */
function entryFileFor(registryDir: string, key: string): string {
	const safe = key.replace(/[^A-Za-z0-9._-]/g, "_");
	const digest = createHash("sha1").update(key).digest("hex").slice(0, 8);
	return join(registryDir, `${safe}-${digest}.yaml`);
}

export function interfacesApi(paths: WorkbenchPaths, projectRoot: string) {
	const legacyRegistryFile = join(paths.interfaces, "registry.yaml");
	const lockFor = (key: string) =>
		join(
			paths.root,
			"locks",
			"registry",
			`${createHash("sha1").update(key).digest("hex").slice(0, 8)}.lock`,
		);

	/**
	 * Pre-0.3 workspaces kept the whole registry in one registry.yaml; split
	 * it into one file per entry on first touch. Concurrent migrators
	 * converge: entry writes are keyed per entry and the legacy remove is
	 * idempotent.
	 */
	async function migrateLegacyRegistry(): Promise<void> {
		if (!(await pathExists(legacyRegistryFile))) {
			return;
		}
		const legacy = await readYamlFile(legacyRegistryFile, registrySchema);
		await mkdir(paths.registry, { recursive: true });
		for (const entry of legacy.entries) {
			await writeYamlFile(
				entryFileFor(paths.registry, entry.key),
				registryEntrySchema,
				entry,
			);
		}
		await rm(legacyRegistryFile, { force: true });
	}

	async function loadEntry(key: string): Promise<RegistryEntry | null> {
		try {
			return await readYamlFile(
				entryFileFor(paths.registry, key),
				registryEntrySchema,
			);
		} catch (error) {
			if (
				error instanceof BlackboardDataError &&
				error.message === "file not found"
			) {
				return null;
			}
			throw error;
		}
	}

	async function saveEntry(entry: RegistryEntry): Promise<void> {
		await mkdir(paths.registry, { recursive: true });
		await writeYamlFile(
			entryFileFor(paths.registry, entry.key),
			registryEntrySchema,
			entry,
		);
	}

	function resolveCanonical(entry: RegistryEntry): string {
		// canonicalPath is repo-relative; hashes must be stable regardless of
		// where the project lives on disk.
		return join(projectRoot, entry.canonicalPath);
	}

	return {
		async list(): Promise<RegistryEntry[]> {
			await migrateLegacyRegistry();
			const names = await safeReaddir(paths.registry);
			const entries = await Promise.all(
				names
					.filter((name) => name.endsWith(".yaml"))
					.map((name) =>
						readYamlFile(join(paths.registry, name), registryEntrySchema),
					),
			);
			return entries.sort((a, b) => a.key.localeCompare(b.key));
		},

		async getEntry(key: string): Promise<RegistryEntry | null> {
			await migrateLegacyRegistry();
			return loadEntry(key);
		},

		/** Insert or replace the entry for `key`. */
		async register(entry: RegistryEntry): Promise<RegistryEntry> {
			await migrateLegacyRegistry();
			const canonical = registryEntryCanonical(entry);
			await withPidLock(lockFor(entry.key), async () => {
				await saveEntry(canonical);
			});
			return canonical;
		},

		async getSubscribers(key: string): Promise<Subscriber[]> {
			const entry = await this.getEntry(key);
			return entry ? [...entry.subscribers] : [];
		},

		/** Anchor the entry to a freshly hashed interface file version. */
		async updateVersion(
			key: string,
			contentHash: string,
			options: UpdateVersionOptions = {},
		): Promise<RegistryEntry> {
			return this.updateEntry(key, { contentHash }, options);
		},

		/** Apply schema-checked metadata under the same CAS lock as hash updates. */
		async updateEntry(
			key: string,
			patch: RegistryUpdate,
			options: UpdateVersionOptions = {},
		): Promise<RegistryEntry> {
			const changes = registryUpdateSchema.parse(patch);
			await migrateLegacyRegistry();
			return withPidLock(lockFor(key), async () => {
				const entry = await loadEntry(key);
				if (!entry) {
					throw new BlackboardDataError(
						`interface not registered: ${key}`,
						entryFileFor(paths.registry, key),
					);
				}
				if (
					options.expectedVersion !== undefined &&
					entry.version !== options.expectedVersion
				) {
					throw new BlackboardConflictError(
						`interface ${key} 版本前置条件不匹配（期望 v${options.expectedVersion}，当前 v${entry.version}）`,
						entryFileFor(paths.registry, key),
						entry,
					);
				}
				const next = registryEntryCanonical({
					...entry,
					...changes,
					version: entry.version + 1,
					lastModified: new Date().toISOString(),
				});
				await saveEntry(next);
				return next;
			});
		},

		/** Compare the registered hash against the interface file on disk. */
		async checkDrift(key: string): Promise<DriftReport> {
			const entry = await this.getEntry(key);
			if (!entry) {
				throw new BlackboardDataError(
					`interface not registered: ${key}`,
					paths.registry,
				);
			}
			const file = resolveCanonical(entry);
			if (!(await pathExists(file))) {
				return {
					key,
					drifted: true,
					registeredHash: entry.contentHash,
					currentHash: null,
					missing: true,
				};
			}
			const currentHash = await hashFile(file);
			return {
				key,
				drifted: currentHash !== entry.contentHash,
				registeredHash: entry.contentHash,
				currentHash,
				missing: false,
			};
		},
	};
}

function registryEntryCanonical(entry: RegistryEntry): RegistryEntry {
	return { ...entry, subscribers: [...entry.subscribers] };
}
