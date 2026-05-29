#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
npm --prefix "$ROOT_DIR" run build
node "$ROOT_DIR/app/dist/main.js" "$@"
