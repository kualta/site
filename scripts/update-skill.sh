#!/usr/bin/env bash
# Pull a vendored skill up to its upstream's latest version, keeping our edits.
#
#   scripts/update-skill.sh openfilm
#
# .agents/skills/<name>/.upstream records the repo, the skill's path in it and the upstream commit our copy is based
# on. The script replays our edits (that commit -> our copy) onto upstream's latest commit, writes the result back
# into .agents/skills/<name> and moves .upstream to the new commit. Review with `git diff`, resolve any conflict
# markers it reports, then commit.
set -euo pipefail

name=${1:?usage: scripts/update-skill.sh <skill>}
dir="$(git rev-parse --show-toplevel)/.agents/skills/$name"
meta="$dir/.upstream"
field() { sed -n "s/^$1=//p" "$meta"; }
repo=$(field repo) subdir=$(field path) base=$(field commit)

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git clone -q --filter=blob:none "$repo" "$tmp/up"
up() { git -C "$tmp/up" -c user.name=update-skill -c user.email=update-skill@localhost "$@"; }
head=$(up rev-parse HEAD)

if [ "$head" = "$base" ]; then
  echo "$name is already at upstream ${head:0:7}"
  exit 0
fi

# Our edits as one commit on top of the base, then replayed onto upstream's head.
up -c advice.detachedHead=false checkout -q "$base"
rsync -a --delete --exclude .upstream --exclude __pycache__ "$dir/" "$tmp/up/$subdir/"
up add -A "$subdir"
conflicts=""
if ! up diff --cached --quiet; then
  up commit -qm "our edits"
  ours=$(up rev-parse HEAD)
  up checkout -q "$head"
  up cherry-pick --no-commit "$ours" >/dev/null 2>&1 || conflicts=$(up diff --name-only --diff-filter=U)
else
  up checkout -q "$head"
fi

rsync -a --delete --exclude .upstream --exclude __pycache__ "$tmp/up/$subdir/" "$dir/"
sed -i '' "s/^commit=.*/commit=$head/" "$meta"

echo "$name: upstream ${base:0:7} -> ${head:0:7}"
up log --format='  %h %s' "$base..$head" -- "$subdir"
if [ -n "$conflicts" ]; then
  echo "Conflicts to resolve (look for <<<<<<< markers):"
  printf '  %s\n' $conflicts
  exit 1
fi
echo "Merged cleanly. Review with: git diff -- .agents/skills/$name"
