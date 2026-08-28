import { join } from "node:path";
import { BlackboardDataError } from "../errors";
import { pathExists } from "../fs/atomic";
import { hashFile } from "../hash";
import type { WorkbenchPaths } from "../paths";
import {
	type Registry,
	type RegistryEntry,
	registrySchema,
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

export function interfacesApi(paths: WorkbenchPaths, projectRoot: string) {
	async function loadRegistry(): Promise<Registry> {
		if (!(await pathExists(paths.registry))) {
			return registrySchema.parse({});
		}
		return readYamlFile(paths.registry, registrySchema);
	}

	async function saveRegistry(registry: Registry): Promise<void> {
		await writeYamlFile(paths.registry, registrySchema, registry);
	}

	function resolveCanonical(entry: RegistryEntry): string {
		// canonicalPath is repo-relative; hashes must be stable regardless of
		// where the project lives on disk.
		return join(projectRoot, entry.canonicalPath);
	}

	return {
		async list(): Promise<RegistryEntry[]> {
			const registry = await loadRegistry();
			return [...registry.entries].sort((a, b) => a.key.localeCompare(b.key));
		},

		async getEntry(key: string): Promise<RegistryEntry | null> {
			const registry = await loadRegistry();
			return registry.entries.find((entry) => entry.key === key) ?? null;
		},

		/** Insert or replace the entry for `key`. */
		async register(entry: RegistryEntry): Promise<RegistryEntry> {
			const registry = await loadRegistry();
			const canonical = registryEntryCanonical(entry);
			const index = registry.entries.findIndex(
				(existing) => existing.key === entry.key,
			);
			if (index >= 0) {
				registry.entries[index] = canonical;
			} else {
				registry.entries.push(canonical);
			}
			await saveRegistry(registry);
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
		): Promise<RegistryEntry> {
			const registry = await loadRegistry();
			const entry = registry.entries.find((existing) => existing.key === key);
			if (!entry) {
				throw new BlackboardDataError(
					`interface not registered: ${key}`,
					paths.registry,
				);
			}
			entry.version += 1;
			entry.contentHash = contentHash;
			entry.lastModified = new Date().toISOString();
			await saveRegistry(registry);
			return entry;
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
