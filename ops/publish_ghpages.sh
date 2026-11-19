#!/bin/bash
# Mirrors the published static site (incl. fresh data) to the gh-pages branch as a single commit.
set -euo pipefail
SRC=/var/www/callledger
DIR=/home/ubuntu/levi-ghp
if [ ! -d "$DIR/.git" ]; then mkdir -p "$DIR" && git -C "$DIR" init -q -b gh-pages; fi
rsync -a --delete --exclude ".git" "$SRC"/ "$DIR"/
touch "$DIR/.nojekyll"
cd "$DIR"
git add -A
if git diff --cached --quiet && git rev-parse -q --verify HEAD >/dev/null; then exit 0; fi
git -c user.name=levi -c user.email=levi@callledger.local commit -q --amend -m "site snapshot" 2>/dev/null || git -c user.name=levi -c user.email=levi@callledger.local commit -q -m "site snapshot"
git -c core.sshCommand="ssh -i /home/ubuntu/.ssh/levi_deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" push -q -f git@github.com:amsjong/callledger.git gh-pages
