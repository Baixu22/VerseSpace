#!/usr/bin/env bash
# 本机 git 修复器：把当前分支的 ref 从 reflog 末尾重新钉回 packed-refs。
#
# 为什么需要它：宿主的 safe-delete 钩子会在 git 清理临时文件时连 .git/refs/heads/
# 一起删掉（2026-09-01 与 2026-09-11 两次实测）。loose ref 一没，`git rev-parse HEAD`
# 就报 unknown revision，后续命令全部不可用。写进 packed-refs 的 ref 不会被清掉，
# 所以每次 git 写操作后重钉一次即可。
#
# 用法：
#   bash scripts/git-ref-repair.sh            # 重钉当前分支
#   bash scripts/git-ref-repair.sh <commit>   # 重钉到指定 commit
#   bash scripts/git-ref-repair.sh --check    # 只检查不修改
set -euo pipefail

cd "$(dirname "$0")/.."

BRANCH="$(cat .git/HEAD | sed -n 's|^ref: refs/heads/||p')"
if [ -z "$BRANCH" ]; then
	echo "HEAD 不是符号引用（detached？）：$(cat .git/HEAD)" >&2
	echo "先 git switch <branch>，或显式传 commit。" >&2
	exit 2
fi

TARGET="${1:-}"

if [ "$TARGET" = "--check" ]; then
	if git rev-parse --verify --quiet "$BRANCH" >/dev/null; then
		echo "OK：$BRANCH = $(git rev-parse --short "$BRANCH")"
		exit 0
	fi
	echo "BROKEN：$BRANCH 不可解析（refs 被清）。跑不含 --check 的重钉。" >&2
	exit 1
fi

if [ -z "$TARGET" ]; then
	# 从来没有 reflog 末尾取：reflog 是本机唯一在两轮删除后都活下来的来源。
	TARGET="$(tail -1 ".git/logs/refs/heads/$BRANCH" 2>/dev/null | awk '{print $2}')"
fi
if [ -z "${TARGET:-}" ]; then
	echo "无法确定 $BRANCH 的目标 commit；请显式传入。" >&2
	exit 2
fi

python - "$BRANCH" "$TARGET" << 'PY'
import sys
branch, target = sys.argv[1], sys.argv[2]
path = ".git/packed-refs"
ref = f"refs/heads/{branch}"
try:
    raw = open(path, encoding="utf-8").read()
except FileNotFoundError:
    raw = "# pack-refs with: peeled fully-peeled sorted \n"
lines = [l for l in raw.rstrip("\n").split("\n") if l.strip()]
out, replaced = [], False
for line in lines:
    if line.endswith(ref):
        out.append(f"{target} {ref}")
        replaced = True
    else:
        out.append(line)
if not replaced:
    if out and out[0].startswith("#"):
        out = out[:1] + [f"{target} {ref}"] + out[1:]
    else:
        out = [f"{target} {ref}"] + out
open(path, "w", encoding="utf-8", newline="\n").write("\n".join(out) + "\n")
print(f"重钉 {ref} -> {target[:7]}")
PY

git rev-parse --short "$BRANCH"
