import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface PidRecord {
	label: string;
	pid: number;
	startedAt: string;
	command: string;
}

export function registryFileFor(
	registryDir: string,
	label: string,
	pid: number,
) {
	const digest = createHash("sha1").update(label).digest("hex").slice(0, 8);
	return join(registryDir, `${digest}-${pid}.json`);
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but is owned by someone else —
		// still alive for our purposes
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Tree kill: the whole tree on Windows, the whole group on POSIX. */
export async function killTree(pid: number): Promise<void> {
	if (process.platform === "win32") {
		await new Promise<void>((resolve) => {
			const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
				stdio: "ignore",
			});
			killer.on("close", () => resolve());
			killer.on("error", () => resolve());
		});
		return;
	}
	try {
		// detached children are their own group leader: negative pid = group
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
}

/**
 * Kill every process found in the pid registry — a restarted runtime adopts
 * the agents its crashed predecessor left behind and puts them down.
 */
export async function reapOrphans(registryDir: string): Promise<number> {
	let names: string[] = [];
	try {
		names = await readdir(registryDir);
	} catch {
		return 0;
	}
	let reaped = 0;
	for (const name of names.filter((n) => n.endsWith(".json"))) {
		const file = join(registryDir, name);
		try {
			const record = JSON.parse(
				await readFile(file, "utf8"),
			) as Partial<PidRecord>;
			if (
				typeof record.pid === "number" &&
				isProcessAlive(record.pid) &&
				record.pid !== process.pid
			) {
				await killTree(record.pid);
				reaped += 1;
			}
		} catch {
			// unparseable record: just clean it up
		}
		await rm(file, { force: true });
	}
	return reaped;
}

export async function registerProcess(
	registryDir: string,
	label: string,
	pid: number,
	command: string | readonly string[],
): Promise<void> {
	try {
		await mkdir(registryDir, { recursive: true });
		await writeFile(
			registryFileFor(registryDir, label, pid),
			JSON.stringify(
				{
					label,
					pid,
					startedAt: new Date().toISOString(),
					command:
						typeof command === "string" ? command : JSON.stringify(command),
				} satisfies PidRecord,
				null,
				2,
			),
			"utf8",
		);
	} catch (error) {
		console.error(
			`[supervisor] pid 注册失败（label=${label} pid=${pid}），孤儿回收将看不到它:`,
			error,
		);
	}
}
