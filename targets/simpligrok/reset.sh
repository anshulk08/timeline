#!/usr/bin/env bash
# Restore simpliGrok local automaintainer-demo branch to the "SEEDED DEMO BUGS" commit.
# Only ever touches that one local branch; never fetches, pushes or touches the remote.
set -euo pipefail
REPO="${SIMPLIGROK_REPO:-/Users/anshul/grokathon/simpliGrok}"
BRANCH=automaintainer-demo
SEED=10351692beddd5b0827462c964562d8b7594844a
cd "$REPO"
git cat-file -e "$SEED^{commit}"
git checkout -q -f "$BRANCH"
git reset -q --hard "$SEED"
git clean -qfd -- frontend/components frontend/lib RAG
# drop AutoMaintainer working branches left over from previous runs (local only)
for b in $(git for-each-ref --format='%(refname:short)' refs/heads/automaintainer/); do git branch -q -D "$b"; done
echo "simpligrok reset to $(git rev-parse --short HEAD) on $BRANCH"
