#!/bin/bash
# NetWatch - Ookla speedtest binary installer
# Detects architecture, downloads correct binary, places in ./bin/speedtest

set -e

INSTALL_DIR="$(dirname "$0")/bin"
TARGET="$INSTALL_DIR/speedtest"
BASE_URL="https://install.speedtest.net/app/cli"

echo ""
echo "  NetWatch - Ookla CLI installer"
echo ""

# Detect architecture
ARCH=$(uname -m)
OS=$(uname -s | tr '[:upper:]' '[:lower:]')

case "$ARCH" in
  aarch64|arm64)
    PKG="ookla-speedtest-1.2.0-linux-aarch64.tgz"
    ;;
  armv7l|armv7|armhf)
    PKG="ookla-speedtest-1.2.0-linux-armhf.tgz"
    ;;
  x86_64|amd64)
    PKG="ookla-speedtest-1.2.0-linux-x86_64.tgz"
    ;;
  i386|i686)
    PKG="ookla-speedtest-1.2.0-linux-i386.tgz"
    ;;
  *)
    echo "  ERROR: Unsupported architecture: $ARCH"
    echo "  Visit https://www.speedtest.net/apps/cli to download manually"
    echo "  Place the binary at: $TARGET"
    exit 1
    ;;
esac

URL="$BASE_URL/$PKG"

echo "  Architecture : $ARCH"
echo "  Package      : $PKG"
echo "  Destination  : $TARGET"
echo ""

# Create bin dir
mkdir -p "$INSTALL_DIR"

# Download
TMP=$(mktemp -d)
echo "  Downloading from $URL ..."
if command -v curl > /dev/null 2>&1; then
  curl -sSL "$URL" -o "$TMP/speedtest.tgz"
elif command -v wget > /dev/null 2>&1; then
  wget -qO "$TMP/speedtest.tgz" "$URL"
else
  echo "  ERROR: curl or wget required"
  exit 1
fi

# Extract
echo "  Extracting ..."
tar -xzf "$TMP/speedtest.tgz" -C "$TMP"
cp "$TMP/speedtest" "$TARGET"
chmod +x "$TARGET"
rm -rf "$TMP"

echo ""
echo "  Installed: $TARGET"
echo ""

# Quick test
echo "  Testing binary ..."
"$TARGET" --version
echo ""
echo "  Done. NetWatch will use this binary for Ookla tests."
echo "  First test run will prompt to accept Ookla license (auto-accepted via --accept-license)."
echo ""
