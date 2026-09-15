#!/bin/bash
# Assembles DSH Shell.app from the SwiftPM build output. The bundle contains
# only the shell binary and the app icon; harness resources (entry script,
# patch files, node_modules) are resolved from the Electron build's Resources
# at runtime, so nothing heavy is duplicated.
#
# Usage:
#   make-app.sh                 # release build, auto-signed (Apple Development id if present)
#   make-app.sh --debug         # debug build (faster compile, get-task-allow entitlement)
#   make-app.sh --sign -        # force ad-hoc signature (no identity)
#   make-app.sh --sign "Name"   # sign with a specific identity
#   make-app.sh --no-sign       # leave unsigned
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ELECTRON_APP="$REPO_ROOT/dist/mac-arm64/DSH Desktop.app"
BUNDLE="$REPO_ROOT/native-shell/build/DSH Shell.app"

CONFIG="release"
SIGN_IDENTITY=""
SIGN_MODE="auto"   # auto | explicit | none

while [[ $# -gt 0 ]]; do
  case "$1" in
    --debug)   CONFIG="debug" ;;
    --release) CONFIG="release" ;;
    --no-sign) SIGN_MODE="none" ;;
    --sign)
      SIGN_MODE="explicit"
      if [[ $# -gt 1 && "$2" != -* ]]; then SIGN_IDENTITY="$2"; shift; fi
      ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

cd "$REPO_ROOT/native-shell"
swift build -c "$CONFIG"

if [ ! -d "$ELECTRON_APP" ]; then
  echo "error: $ELECTRON_APP not found — run 'npm run package:dir' once first" >&2
  exit 1
fi

rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"

# Signed bundles may not contain symlinks, so Resources is NOT linked to the
# Electron app's directory. The shell binary resolves the harness entry,
# patch files, and node_modules from the Electron build path at runtime
# (resourcesURL in main.swift, overridable via DSH_SHELL_RESOURCES).
# Only the icon is copied in — CFBundleIconFile needs a real file.
cp "$ELECTRON_APP/Contents/Resources/icon.icns" "$BUNDLE/Contents/Resources/icon.icns"

# icon.icns lives in the shared Electron Resources; CFBundleIconFile picks it
# up through the symlink for the Dock, Finder, and the ⌘-tab switcher.
cat > "$BUNDLE/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key><string>DSHShell</string>
    <key>CFBundleIdentifier</key><string>app.dsh.shell</string>
    <key>CFBundleName</key><string>DSH Shell</string>
    <key>CFBundleDisplayName</key><string>DSH Shell</string>
    <key>CFBundleIconFile</key><string>icon</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>0.1.0</string>
    <key>CFBundleVersion</key><string>1</string>
    <key>LSMinimumSystemVersion</key><string>13.0</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
PLIST

cp "$(swift build -c "$CONFIG" --show-bin-path)/DSHShell" "$BUNDLE/Contents/MacOS/DSHShell"

# --- signing -----------------------------------------------------------------
# A signed shell avoids WKWebView/Keychain quirks with fully unsigned bundles
# and keeps Gatekeeper quiet for local use. Auto mode prefers your Apple
# Development identity, falls back to ad-hoc.
#
# Deliberately NO entitlements: com.apple.security.* keys are restricted —
# AMFI SIGKILLs any bundle carrying them without matching provisioning — and
# an unsandboxed personal shell needs none. Notarization/hardened runtime are
# equally unnecessary for a build that never leaves this machine.
resolve_auto_identity() {
  security find-identity -v -p codesigning 2>/dev/null \
    | awk -F'"' '/Apple Development:/ {print $2; exit}'
}

if [ "$SIGN_MODE" != "none" ]; then
  if [ "$SIGN_MODE" = "explicit" ] && [ -n "$SIGN_IDENTITY" ]; then
    IDENTITY="$SIGN_IDENTITY"
  else
    IDENTITY="$(resolve_auto_identity)"
    [ -z "$IDENTITY" ] && IDENTITY="-"
  fi

  codesign --force --deep --sign "$IDENTITY" "$BUNDLE"
  codesign --verify --deep --strict "$BUNDLE"
  echo "signed with: $IDENTITY"
else
  echo "left unsigned"
fi

du -sh "$BUNDLE"
echo "built: $BUNDLE ($CONFIG)"
echo
echo "run it with:"
echo "  open '$BUNDLE'"
echo "or from a terminal (keeps your shell PATH and stderr visible):"
echo "  '$BUNDLE/Contents/MacOS/DSHShell'"
