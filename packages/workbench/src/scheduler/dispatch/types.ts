export interface DispatchResult {
	ok: boolean;
	goalId: string;
	workspotId?: string;
	worktree?: string;
	reason?: string;
	/**
	 * TF-0117 / TF-0202: a machine-readable refusal, so a caller can branch on
	 * the cause instead of matching substrings in `reason`. Present only on
	 * failures that were diagnosed rather than relayed from git's stderr.
	 */
	error?:
		| { code: "invalid_branch_name"; branch: string; detail: string }
		| {
				code: "branch_in_use";
				branch: string;
				holder: string;
				detail: string;
		  };
}
