#!/usr/bin/env bash
# Push a fresh single-commit snapshot of the current tree to JihuLab (CI mirror).
#
# Why not a plain `git push jihulab`: the local .git carries ~2 GB of
# events.jsonl history (the task forest is committed on every closeout).
# JihuLab only needs the current tree to run CI, so we push an ORPHAN single
# commit with no history. GitHub (origin) stays the source of truth.
# See AGENTS.md §"CI remotes".
#
# Why the target ref is not simply the branch name: `main` and `feat/*` are
# PROTECTED on JihuLab and the pre-receive hook rejects a force-push to them.
# The default target therefore drops the `feat/`-style prefix (`feat/x` -> `x`);
# pass a ref explicitly to override.
#
# Usage:
#   scripts/win/jihulab-snapshot.sh [ref]
# ref defaults to the current branch with its prefix stripped. Override the
# remote with JIHULAB_REMOTE (default: jihulab).
set -euo pipefail

REMOTE="${JIHULAB_REMOTE:-jihulab}"
CURRENT="$(git rev-parse --abbrev-ref HEAD)"
SRC_SHA="$(git rev-parse --short HEAD)"
# Strip everything up to the last `/`: the protected patterns are `main` and `feat/*`.
REF="${1:-${CURRENT##*/}}"

# The snapshot must mirror a real, clean commit — refuse a dirty tree.
if [ -n "$(git status --porcelain)" ]; then
	echo "working tree not clean; commit or stash first" >&2
	exit 1
fi

# Fail here rather than letting the remote's pre-receive hook explain it.
case "$REF" in
main | master | feat/*)
	echo "ref '${REF}' is protected on JihuLab (force-push is rejected)." >&2
	echo "pass a flat ref instead, e.g.:" >&2
	echo "  scripts/win/jihulab-snapshot.sh ${REF##*/}" >&2
	exit 1
	;;
esac

# `commit-tree` writes one object and nothing else: no checkout, no local
# branch, no ref to clean up. That matters on this host, where git writes to
# loose refs can be lost (see AGENTS.md §"Git refs"). The commit stays dangling
# until the push below makes it reachable from the remote.
TREE="$(git rev-parse 'HEAD^{tree}')"
SNAP="$(git commit-tree "$TREE" -m "snapshot: VerseSpace @ ${SRC_SHA} - jihulab CI mirror (no history)")"

GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=no -o BatchMode=yes" \
	git push -f "$REMOTE" "${SNAP}:refs/heads/${REF}"

echo "pushed snapshot of ${SRC_SHA} -> ${REMOTE}/${REF}"
echo "pipeline: https://jihulab.com/Baixu22/VerseSpace/-/pipelines?ref=${REF}"
