const SIMPLE_READS = new Set([
	"cat",
	"head",
	"tail",
	"nl",
	"bat",
	"tac",
	"ls",
	"dir",
	"tree",
	"exa",
	"eza",
	"stat",
	"file",
	"wc",
	"du",
	"df",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"ag",
	"ack",
	"find",
	"fd",
	"locate",
	"which",
	"whereis",
	"sort",
	"uniq",
	"cut",
	"tr",
	"rev",
	"paste",
	"join",
	"column",
	"fmt",
	"fold",
	"comm",
	"diff",
	"cmp",
	"echo",
	"printf",
	"pwd",
	"whoami",
	"uname",
	"printenv",
	"id",
	"uptime",
	"jq",
]);
const GIT_READS = new Set([
	"show",
	"diff",
	"log",
	"status",
	"blame",
	"grep",
	"rev-parse",
	"ls-files",
	"ls-tree",
	"cat-file",
]);

/** This is a display classifier, not a shell sandbox. Ambiguous syntax stays visible. */
function segments(command: string): string[][] | undefined {
	const result: string[][] = [];
	let words: string[] = [];
	let word = "";
	let started = false;
	let quote: string | undefined;
	const flushWord = () => {
		if (started) words.push(word);
		word = "";
		started = false;
	};
	for (let i = 0; i < command.length; i++) {
		const char = command[i]!;
		if (quote === "'") {
			if (char === quote) quote = undefined;
			else word += char;
			continue;
		}
		if (char === "$" || char === "`") return undefined;
		if (char === "\\") {
			const next = command[++i];
			if (!next || next === "\n" || next === "\r") return undefined;
			word += next;
			started = true;
			continue;
		}
		if (quote === '"') {
			if (char === quote) quote = undefined;
			else word += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			started = true;
			continue;
		}
		if (/[<>\n\r(){}]/.test(char)) return undefined;
		if (char === "|" || char === ";" || char === "&") {
			if (char === "&" && command[i + 1] !== "&") return undefined;
			flushWord();
			if (!words.length) return undefined;
			result.push(words);
			words = [];
			if ((char === "|" || char === "&") && command[i + 1] === char) i++;
		} else if (/\s/.test(char)) flushWord();
		else {
			word += char;
			started = true;
		}
	}
	if (quote) return undefined;
	flushWord();
	if (!words.length) return undefined;
	result.push(words);
	return result;
}

function unsafeArgs(name: string, args: string[]): boolean {
	if (
		args.some((arg) =>
			/^(--output|--pre|--hostname-bin|--exec|--exec-batch|--command|--upload|--in-place)(=|$)/.test(
				arg,
			),
		)
	)
		return true;
	if (name === "find")
		return args.some((arg) =>
			/^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(arg),
		);
	if (name === "fd")
		return args.some((arg) => /^(-x|-X|--exec|--exec-batch)/.test(arg));
	if (name === "sort")
		return args.some(
			(arg) => /^-[^-]*o/.test(arg) || arg.startsWith("--compress-program"),
		);
	if (name === "file")
		return args.some((arg) => arg === "-C" || arg === "--compile");
	if (name === "bat")
		return args.some(
			(arg) => arg.startsWith("--pager") || arg.startsWith("--config"),
		);
	if (name === "tree") return args.some((arg) => /^-o/.test(arg));
	// uniq's second positional argument is an output file.
	if (name === "uniq")
		return args.filter((arg) => !arg.startsWith("-")).length > 1;
	return false;
}

function readonlyGit(args: string[]): boolean {
	let index = 0;
	while (index < args.length && args[index]?.startsWith("-")) {
		if (args[index] === "-C") index += 2;
		else if (["--no-pager", "--literal-pathspecs"].includes(args[index]!))
			index++;
		else return false;
	}
	if (!GIT_READS.has(args[index] ?? "")) return false;
	return !args
		.slice(index + 1)
		.some((arg) =>
			/^(--output|--ext-diff|--textconv|--no-index|--open-files-in-pager|--filters)(=|$)/.test(
				arg,
			),
		);
}

function readonlySegment(words: string[], depth: number): boolean {
	const name = words[0]?.split("/").at(-1) ?? "";
	const args = words.slice(1);
	if (["sh", "bash", "zsh", "dash"].includes(name)) {
		return (
			depth < 3 &&
			args.length === 2 &&
			/^-(?:l?c|cl)$/.test(args[0]!) &&
			isReadonlyShell(args[1]!, depth + 1)
		);
	}
	if (name === "git") return readonlyGit(args);
	if (name === "sed") {
		return (
			args[0] === "-n" &&
			/^\d+(?:,(?:\d+|\$))?p$/.test(args[1] ?? "") &&
			args.slice(2).every((arg) => !arg.startsWith("-"))
		);
	}
	return SIMPLE_READS.has(name) && !unsafeArgs(name, args);
}

export function isReadonlyShell(command: string, depth = 0): boolean {
	const parts = segments(command.trim());
	return !!parts?.length && parts.every((part) => readonlySegment(part, depth));
}
