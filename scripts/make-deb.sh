#!/bin/sh
# Build a .deb package for qe (linux-x86_64 only).
# Requires: dpkg-deb (part of dpkg), fakeroot
#
# Usage:
#   sh scripts/make-deb.sh <version>
#   e.g.  sh scripts/make-deb.sh 0.1.0
#
# Output: qe_<version>_amd64.deb at repo root.

set -e
VERSION="${1:?Usage: make-deb.sh <version>}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGING="$ROOT/release-staging/deb"
PKG="$STAGING/qe_${VERSION}_amd64"

rm -rf "$PKG"
mkdir -p "$PKG/DEBIAN" \
         "$PKG/usr/bin" \
         "$PKG/usr/lib/qe"

# Control file
cat > "$PKG/DEBIAN/control" <<EOF
Package: qe
Version: $VERSION
Architecture: amd64
Maintainer: KO <djkroq@gmail.com>
Depends: nodejs (>= 22)
Description: Terminal editor with Vim keybindings, Git, LSP, and AI support
EOF

# Payload — expects tarball already extracted or files at these paths
TARDIR="$ROOT/release-staging/qe-v${VERSION}-linux-x86_64"
if [ ! -d "$TARDIR" ]; then
  echo "Run 'node scripts/package.mjs v${VERSION} linux-x86_64' first to create $TARDIR" >&2
  exit 1
fi

cp "$TARDIR/libexec/main.js"     "$PKG/usr/lib/qe/main.js"
cp "$TARDIR/libexec/editor-core" "$PKG/usr/lib/qe/editor-core"
chmod 755 "$PKG/usr/lib/qe/editor-core"

cat > "$PKG/usr/bin/qe" <<'SH'
#!/bin/sh
exec node /usr/lib/qe/main.js "$@"
SH
chmod 755 "$PKG/usr/bin/qe"

# Build .deb
fakeroot dpkg-deb --build "$PKG" "$ROOT/qe_${VERSION}_amd64.deb"
echo "Created: qe_${VERSION}_amd64.deb"
