#!/usr/bin/env bash
# dsh-tidewatch build: pure-JS hand-written bundle, no compile step.
# (No build:client script in package.json — tsdown would overwrite the
# hand-written __ModuleLoader__ bundle in lib/client.js.)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "[dsh-tidewatch] syntax check..."
node --check lib/pricing.js
node --check lib/index.js
node --check lib/client.js

# Dependency junction: link zod from the checkout (the projection schema needs a zod v4 instance).
# Point DSH_CHECKOUT at the DeepSeek Harness source root (the one containing node_modules/zod).
CHECKOUT="${DSH_CHECKOUT:-}"
if [ -n "$CHECKOUT" ] && [ -d "$CHECKOUT/node_modules/zod" ]; then
  mkdir -p node_modules
  node -e "
    const fs = require('fs'), path = require('path');
    const link = path.resolve('node_modules/zod');
    const target = path.resolve(process.argv[1]);
    fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  " "$CHECKOUT/node_modules/zod"
  echo "[dsh-tidewatch] zod junction -> $CHECKOUT/node_modules/zod"
else
  echo "[dsh-tidewatch] warn: DSH_CHECKOUT not set or missing node_modules/zod; skip zod junction (fine when the host already resolves zod)"
fi

echo "[dsh-tidewatch] build ok (pure JS, no compile step)"
