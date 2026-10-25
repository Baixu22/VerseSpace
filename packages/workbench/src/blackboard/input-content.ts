import { isAbsolute, resolve } from "node:path";
import { hashText } from "../hash";
import type { InputObservation } from "./session-types";

export type InputSelector = Extract<
	InputObservation,
	{ source: "tool-observed" }
>["selector"];
export type ReturnedInput =
	| { returned: string; content: string; selector: InputSelector }
	| { reason: string };

/** utf8-lines-v1: CRLF becomes LF; preserve all other text, including final LF. */
export function normalizeInput(text: string): string {
	return text.replace(/\r\n/g, "\n");
}

/** Only the retained one-file cat shape. No flags, pipes, expansion or shell parser. */
export function singleCatPath(command: string): string | undefined {
	let inner = command.trim();
	const shell = inner.match(/^(?:\S*\/)?(?:zsh|bash|sh) -lc (['"])(.*)\1$/);
	if (shell) inner = shell[2]!;
	const match = inner.match(
		/^cat\s+(?:"([^"$`\r\n]+)"|'([^'$`\r\n]+)'|([^\s'"|;&<>$`]+))$/,
	);
	const path = match?.[1] ?? match?.[2] ?? match?.[3];
	return path && !path.startsWith("-") && !/[*?[\]{}~]/.test(path)
		? path
		: undefined;
}

export function sameInputPath(root: string, a: string, b: string): boolean {
	const absolute = (path: string) =>
		resolve(isAbsolute(path) ? path : resolve(root, path));
	return absolute(a) === absolute(b);
}

export function inputContentHash(text: string): string {
	return hashText(normalizeInput(text));
}
