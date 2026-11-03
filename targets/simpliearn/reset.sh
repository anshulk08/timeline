#!/usr/bin/env bash
# Restore SimpliEarn's local automaintainer-demo branch to the "SEEDED DEMO BUGS" commit.
# Only ever touches that one local branch; never fetches, pushes or touches the remote.
set -euo pipefail
REPO="${SIMPLIEARN_REPO:-/Users/anshul/grokathon/simpli-earn}"
BRANCH=automaintainer-demo
SEED=aebe2d08b5d95035d45bcdf6b9b5b03d9625c779
cd "$REPO"
git cat-file -e "$SEED^{commit}"
git checkout -q -f "$BRANCH"
git reset -q --hard "$SEED"
git clean -qfd -- frontend/components frontend/lib RAG
# drop AutoMaintainer working branches left over from previous runs (local only)
for b in $(git for-each-ref --format='%(refname:short)' refs/heads/automaintainer/); do git branch -q -D "$b"; done
echo "simpliearn reset to $(git rev-parse --short HEAD) on $BRANCH"
