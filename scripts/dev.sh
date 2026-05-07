#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
APP_DIR="$ROOT_DIR/app"

npm --prefix "$APP_DIR" run build
node "$APP_DIR/dist/main.js" "$@"
