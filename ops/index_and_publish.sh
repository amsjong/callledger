#!/bin/bash
# Runs the CallLedger indexer once, then publishes the static site to nginx's web root.
set -euo pipefail
cd /home/ubuntu/levi
python3 indexer/index.py --once
rsync -a --delete --exclude ".*" --exclude "package.json" web/site/ /var/www/callledger/
