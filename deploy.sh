#!/usr/bin/env bash
# One command: rebuild from the public API and publish to GitHub Pages (main:/docs).
set -euo pipefail
cd "$(dirname "$0")"

node build.mjs
python3 tools/og.py

git add -A docs data
if git diff --cached --quiet; then
  echo "no data change — nothing to deploy (site is already current)"
  exit 0
fi

git commit -m "data: refresh $(date -u +%Y-%m-%dT%H:%MZ)"
# the Action backup may have pushed since our last fetch — rebase before pushing
git pull --rebase --no-edit origin main >/dev/null 2>&1 || true
git push origin main
echo "deployed → https://arrijalu.github.io/taskmarket-live/"
