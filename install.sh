#!/bin/sh
# Universal qe installer — works on macOS (arm64/x86_64) and Linux (x86_64).
# Usage:  curl -fsSL https://raw.githubusercontent.com/kroq86/ide/main/install.sh | sh
# Or:     curl -fsSL https://raw.githubusercontent.com/kroq86/ide/main/install.sh | sh -s -- --prefix /usr/local

set -e

VERSION="0.1.0"
REPO="kroq86/ide"
PREFIX="${1:---prefix}"
if [ "$PREFIX" = "--prefix" ]; then PREFIX="${2:-/usr/local}"; fi

die() { echo "error: $*" >&2; exit 1; }

# Detect platform
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS-$ARCH" in
  Darwin-arm64)   PLATFORM="darwin-arm64" ;;
  Darwin-x86_64)  PLATFORM="darwin-x86_64" ;;
  Linux-x86_64)   PLATFORM="linux-x86_64" ;;
  *) die "Unsupported platform: $OS $ARCH" ;;
esac

# Require node 22+
command -v node >/dev/null 2>&1 || die "Node.js 22+ is required (https://nodejs.org)"
NODE_MAJOR="$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')"
[ "${NODE_MAJOR:-0}" -ge 22 ] 2>/dev/null || die "Node.js 22+ required (current: $(node --version))"

TARBALL="qe-v${VERSION}-${PLATFORM}.tar.gz"
URL="https://github.com/${REPO}/releases/download/v${VERSION}/${TARBALL}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading $TARBALL..."
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$URL" -o "$TMP/$TARBALL"
elif command -v wget >/dev/null 2>&1; then
  wget -q "$URL" -O "$TMP/$TARBALL"
else
  die "curl or wget required"
fi

echo "Installing to $PREFIX ..."
tar -xzf "$TMP/$TARBALL" -C "$TMP"
DIR="$TMP/qe-v${VERSION}-${PLATFORM}"
mkdir -p "$PREFIX/bin" "$PREFIX/libexec/qe"
cp "$DIR/libexec/main.js" "$PREFIX/libexec/qe/main.js"
cp "$DIR/libexec/editor-core" "$PREFIX/libexec/qe/editor-core"
chmod 755 "$PREFIX/libexec/qe/editor-core"

cat > "$PREFIX/bin/qe" <<SH
#!/bin/sh
exec node "$PREFIX/libexec/qe/main.js" "\$@"
SH
chmod 755 "$PREFIX/bin/qe"

echo "Installed qe $VERSION -> $PREFIX/bin/qe"
echo "Make sure $PREFIX/bin is in your PATH."
