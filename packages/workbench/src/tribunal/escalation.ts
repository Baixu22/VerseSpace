import type { TribunalCandidate } from "../types/tribunal";

/**
 * NEWS2-style single-parameter escalation: one red value outranks the
 * combined score. NEWS2 works because a single terrifying number bypasses the
 * aggregate — a patient whose aggregate looks fine can still be dying of one
 * number.
 *
 * Here the three red numbers are the ones where being slow costs more than
 * being wrong: touching authentication code, force-pushing, and materializing
 * a secret. Each jumps the item straight to `critical` regardless of kind or
 * score, and says which parameter fired.
 */

/** Paths whose modification needs a human even when nothing else is wrong. */
const AUTH_PATH =
	/(^|\/)(auth|authn|authz|login|session|credential|credentials|password|passwd|secret|secrets|token|tokens|sudo|sudoers|pam\.d|keytab|kms|iam)(\/|\.|$)|(^|\/)\.env(\.|$)|(^|\/)id_(rsa|dsa|ecdsa|ed25519)$|\.pem$|\.p12$|\.pfx$|\.key$/i;

/** `git push --force` in every spelling the CLIs accept. */
const FORCE_PUSH =
	/\bgit\s+push\b[^\n|;&]*(--force|-f\b|force-with-lease)|\bpush\s+(-f|--force)\b/i;

/** A literal secret, not a variable that might hold one. */
const SECRET_MATERIAL =
	/-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bsk-[A-Za-z0-9]{20,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}/;

export interface Escalation {
	reason: string;
	parameter: "auth_path" | "force_push" | "secret_material";
}

/**
 * Scan a candidate's evidence. Returns the first red parameter found, or null
 * when nothing is on fire — the common case, and the one that must stay cheap.
 */
export function scanEscalation(
	evidence: TribunalCandidate["evidence"],
): Escalation | null {
	if (!evidence) {
		return null;
	}
	for (const path of evidence.paths ?? []) {
		if (AUTH_PATH.test(path)) {
			return { reason: `触碰认证/凭据路径：${path}`, parameter: "auth_path" };
		}
	}
	for (const command of evidence.commands ?? []) {
		if (FORCE_PUSH.test(command)) {
			return {
				reason: `执行了 force-push：${command.slice(0, 120)}`,
				parameter: "force_push",
			};
		}
	}
	const content = evidence.content;
	if (content && SECRET_MATERIAL.test(content)) {
		return {
			reason: "检出疑似密钥内容（已隐去具体值）",
			parameter: "secret_material",
		};
	}
	for (const path of evidence.paths ?? []) {
		if (SECRET_MATERIAL.test(path)) {
			return { reason: "路径中疑似含密钥材料", parameter: "secret_material" };
		}
	}
	return null;
}
