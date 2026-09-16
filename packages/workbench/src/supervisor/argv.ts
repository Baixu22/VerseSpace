import { stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Quote-aware command-line split. Quotes only wrap a token when they appear
 * at the token boundary (`bun "my tool.js" -x`); quotes INSIDE a token are
 * literal, so JSON arguments like `--settings {"a":"b"}` survive intact.
 */
export function splitCommandLine(line: string): string[] {
	const args: string[] = [];
	let current = "";
	let hasToken = false;
	let tokenQuoted = false;
	let atBoundary = true;
	for (const ch of line) {
		if (!tokenQuoted && /\s/.test(ch)) {
			if (hasToken) {
				args.push(current);
				current = "";
				hasToken = false;
			}
			atBoundary = true;
			continue;
		}
		if (ch === '"') {
			if (atBoundary) {
				tokenQuoted = true; // opening quote: wraps the token
			} else if (tokenQuoted) {
				tokenQuoted = false; // closing quote
			} else {
				current += ch; // inner quote in an unquoted token: literal
			}
			hasToken = true;
			atBoundary = false;
			continue;
		}
		current += ch;
		hasToken = true;
		atBoundary = false;
	}
	if (hasToken) {
		args.push(current);
	}
	return args;
}

const WINDOWS_PATH_EXTS = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
	.split(";")
	.filter((ext) => ext.length > 0);

async function fileExists(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

async function resolveWindowsExecutable(
	command: string,
): Promise<string | null> {
	if (/^[a-zA-Z]:[\\/]/.test(command) || command.startsWith("\\\\")) {
		return command; // absolute — use as-is
	}
	const dirs = [
		process.cwd(),
		...(process.env.PATH ?? "").split(";").filter((dir) => dir.length > 0),
	];
	for (const dir of dirs) {
		const bare = join(dir, command);
		if (/\.(exe|cmd|bat|com)$/i.test(command)) {
			if (await fileExists(bare)) {
				return bare;
			}
			continue;
		}
		for (const ext of WINDOWS_PATH_EXTS) {
			const candidate = `${bare}${ext.toLowerCase()}`;
			if (await fileExists(candidate)) {
				return candidate;
			}
		}
	}
	return null;
}

export async function resolveSpawnCommand(argv: string[]) {
	let file = argv[0] ?? "";
	let args = argv.slice(1);
	// Windows 的 .cmd/.bat 垫片必须经 cmd.exe 执行，且要用「逐字命令行」传参
	// （原因见下方 spawn 处的注释）。
	let verbatimArgs = false;
	if (process.platform === "win32") {
		const resolved = await resolveWindowsExecutable(file);
		if (resolved === null) {
			return null;
		}
		file = resolved;
		if (/\.(cmd|bat)$/i.test(resolved)) {
			// npm shim: cmd.exe must run it; /s normalizes the quoting of
			// the whole command line, which we build from argv pieces.
			// Bare name on purpose: bun's uv_spawn rejects some absolute
			// cmd.exe paths but resolves cmd.exe from PATH reliably.
			const quoted = [resolved, ...args]
				.map((part) => (part.includes(" ") ? `"${part}"` : part))
				.join(" ");
			// 再包一层引号：`cmd /s` 会剥掉最外层的**一对**引号，所以
			// `cmd /c ""C:\a b\x.cmd" arg"` 才是「路径带空格」的标准形式；
			// 只给路径加引号时，cmd 剥掉的是那对引号，路径在空格处断掉。
			args = ["/d", "/s", "/c", `"${quoted}"`];
			file = "cmd.exe";
			verbatimArgs = true;
		}
	}

	// bun's Windows uv_spawn mangles backslash paths in `file` and fails
	// outright on a backslash `cwd` when a custom env is passed; forward
	// slashes resolve fine everywhere Windows APIs accept them
	if (process.platform === "win32") {
		file = file.replace(/\\/g, "/");
	}

	return { file, args, verbatimArgs };
}
