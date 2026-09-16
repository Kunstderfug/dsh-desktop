#!/bin/bash
# Generate, install, and self-test the "Copy to Applications" Finder Quick
# Action: right-click an .app bundle in Finder and copy it into /Applications.
#
# The service is an Automator-style .workflow bundle living in
# ~/Library/Services/. Nothing here is compiled: the bundle is two plists
# (Contents/Info.plist for the NSServices contract, Contents/document.wflow
# for the single Run Shell Script action), written into a staging dir by this
# script and then copied into place. The NSServices contract filters the
# Finder context menu to .app bundles via NSSendFileTypes:
# [com.apple.application-bundle]. Copying uses plain `ditto`, which works
# unprivileged because /Applications is root:admin drwxrwxr-w and the service
# runs as the logged-in (admin) user; a Finder-duplicate fallback covers
# locked-down machines.
#
# The .workflow bundle is generated on the machine — it is NOT committed to
# this repo.
#
# Usage:
#   create-copy-to-applications-service.sh                # generate + install
#   create-copy-to-applications-service.sh --uninstall    # remove + flush
#   create-copy-to-applications-service.sh --self-test    # end-to-end check
#
# Env (consumed by the installed service at copy time, not by this script):
#   COPY_TO_APPS_REPLACE=1  replace an existing /Applications/<name> without
#                           asking. DANGEROUS for running apps (rm -rf of a
#                           live bundle, old copy unrecoverable). Off by
#                           default; without it the service shows a
#                           Replace/Skip dialog for each existing app.
set -euo pipefail

SERVICES_DIR="$HOME/Library/Services"
BUNDLE_NAME="Copy to Applications.workflow"
STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/copy-to-apps.XXXXXX")"
# The staging dir always goes; the two self-test artifacts are swept too so a
# mid-test crash can never leave MT4-Test.app behind in /Applications or /tmp.
trap 'rm -rf "$STAGE_DIR"; if [ "${MODE:-}" = "self-test" ]; then rm -rf "/Applications/MT4-Test.app" "/tmp/MT4-Test.app"; fi' EXIT

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# pbs is the macOS services daemon; -flush makes it rescan ~/Library/Services
# so a freshly installed (or removed) Quick Action takes effect without
# logging out.
flush_services() {
  /System/Library/CoreServices/pbs -flush
}

# XML-escape a command string and splice it into the document.wflow template
# at the __COMMAND_STRING__ placeholder. Done with perl (present on every
# macOS) using index/substr so no character in the command can be mistaken
# for regex or replacement syntax.
splice_command_string() { # <doc.wflow> <raw-command-file>
  cat > "$STAGE_DIR/splice.pl" <<'PERL_EOF'
use strict; use warnings;
my ($doc_path, $cmd_path, $ph) = @ARGV;
local $/;
open my $df, "<", $doc_path or die "read $doc_path: $!\n";
my $doc = <$df>; close $df;
open my $cf, "<", $cmd_path or die "read $cmd_path: $!\n";
my $cmd = <$cf>; close $cf;
$cmd =~ s/&/&amp;/g;
$cmd =~ s/</&lt;/g;
$cmd =~ s/>/&gt;/g;
$cmd =~ s/"/&quot;/g;
$cmd =~ s/'/&apos;/g;
my $pos = index($doc, $ph);
die "placeholder $ph not found in $doc_path\n" if $pos < 0;
substr($doc, $pos, length($ph)) = $cmd;
open my $of, ">", $doc_path or die "write $doc_path: $!\n";
print {$of} $doc; close $of;
PERL_EOF
  /usr/bin/perl "$STAGE_DIR/splice.pl" "$1" "$2" "__COMMAND_STRING__"
}

# ---------------------------------------------------------------------------
# Bundle generation
# ---------------------------------------------------------------------------

# Write the staged bundle: Contents/{Info.plist,document.wflow}. Structure
# mirrors the proven "Open in ZCode.workflow" service on this machine
# (NSServices contract in Info.plist; single Run Shell Script action in
# document.wflow with COMMAND_STRING/inputMethod=1/shell=/bin/zsh/source="").
create_bundle() {
  local bundle_dir="$STAGE_DIR/$BUNDLE_NAME"
  rm -rf "$bundle_dir"
  mkdir -p "$bundle_dir/Contents"

  # Info.plist — the NSServices contract Finder reads. CFBundle* keys form
  # the bundle skeleton; NSIconName/NSBackgroundColorName give the item its
  # standard Quick Action look in System Settings and context menus.
  cat > "$bundle_dir/Contents/Info.plist" <<'PLIST_EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>English</string>
  <key>CFBundleExecutable</key>
  <string></string>
  <key>CFBundleIdentifier</key>
  <string>local.quickaction.copy-to-applications</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Copy to Applications</string>
  <key>CFBundlePackageType</key>
  <string>BNDL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>NSServices</key>
  <array>
    <dict>
      <key>NSBackgroundColorName</key>
      <string>background</string>
      <key>NSIconName</key>
      <string>NSActionTemplate</string>
      <key>NSMenuItem</key>
      <dict>
        <key>default</key>
        <string>Copy to Applications</string>
      </dict>
      <key>NSMessage</key>
      <string>runWorkflowAsService</string>
      <key>NSRequiredContext</key>
      <dict>
        <key>NSApplicationIdentifier</key>
        <string>com.apple.finder</string>
      </dict>
      <key>NSSendFileTypes</key>
      <array>
        <string>com.apple.application-bundle</string>
      </array>
    </dict>
  </array>
</dict>
</plist>
PLIST_EOF

  # document.wflow — template with the shell command spliced in below.
  cat > "$STAGE_DIR/document.wflow" <<'WFLOW_EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>actions</key>
  <array>
    <dict>
      <key>action</key>
      <dict>
        <key>ActionBundlePath</key>
        <string>/System/Library/Automator/Run Shell Script.action</string>
        <key>ActionName</key>
        <string>Run Shell Script</string>
        <key>ActionParameters</key>
        <dict>
          <key>CheckedForUserDefaultShell</key>
          <true/>
          <key>COMMAND_STRING</key>
          <string>__COMMAND_STRING__</string>
          <key>inputMethod</key>
          <integer>1</integer>
          <key>shell</key>
          <string>/bin/zsh</string>
          <key>source</key>
          <string></string>
        </dict>
        <key>AMAccepts</key>
        <dict>
          <key>Container</key>
          <string>List</string>
          <key>Optional</key>
          <true/>
          <key>Types</key>
          <array>
            <string>com.apple.cocoa.path</string>
          </array>
        </dict>
        <key>AMActionVersion</key>
        <string>2.0.3</string>
        <key>AMApplication</key>
        <array>
          <string>Automator</string>
        </array>
        <key>AMParameterProperties</key>
        <dict>
          <key>CheckedForUserDefaultShell</key>
          <dict/>
          <key>COMMAND_STRING</key>
          <dict/>
          <key>inputMethod</key>
          <dict/>
          <key>shell</key>
          <dict/>
          <key>source</key>
          <dict/>
        </dict>
        <key>AMProvides</key>
        <dict>
          <key>Container</key>
          <string>List</string>
          <key>Types</key>
          <array>
            <string>com.apple.cocoa.string</string>
          </array>
        </dict>
        <key>BundleIdentifier</key>
        <string>com.apple.RunShellScript</string>
        <key>CanShowSelectedItemsWhenRun</key>
        <false/>
        <key>CanShowWhenRun</key>
        <true/>
        <key>Category</key>
        <array>
          <string>AMCategoryUtilities</string>
        </array>
        <key>CFBundleVersion</key>
        <string>2.0.3</string>
        <key>Class Name</key>
        <string>RunShellScriptAction</string>
        <key>InputUUID</key>
        <string>AE2D029E-C0FA-4869-AB22-ABEB92DA80C2</string>
        <key>Keywords</key>
        <array>
          <string>Shell</string>
          <string>Script</string>
        </array>
        <key>OutputUUID</key>
        <string>34A0482F-8778-43A4-8F44-59F4C5E3EB3A</string>
        <key>UnlocalizedApplications</key>
        <array>
          <string>Automator</string>
        </array>
        <key>UUID</key>
        <string>E29D0DB6-BDFE-42E8-B370-72DBD7C4CF85</string>
      </dict>
      <key>isViewVisible</key>
      <true/>
    </dict>
  </array>
  <key>AMApplicationBuild</key>
  <string>521</string>
  <key>AMApplicationVersion</key>
  <string>2.10</string>
  <key>AMDocumentVersion</key>
  <string>2</string>
  <key>connectors</key>
  <dict/>
  <key>workflowMetaData</key>
  <dict>
    <key>serviceApplicationBundleID</key>
    <string>com.apple.finder</string>
    <key>serviceApplicationPath</key>
    <string>/System/Library/CoreServices/Finder.app</string>
    <key>serviceInputTypeIdentifier</key>
    <string>com.apple.Automator.fileSystemObject</string>
    <key>serviceOutputTypeIdentifier</key>
    <string>com.apple.Automator.nothing</string>
    <key>serviceProcessesInput</key>
    <false/>
    <key>workflowTypeIdentifier</key>
    <string>com.apple.Automator.servicesMenu</string>
  </dict>
</dict>
</plist>
WFLOW_EOF

  # The zsh body the Run Shell Script action executes. Selected file paths
  # arrive as arguments ("$@") because inputMethod is 1 (as arguments).
  cat > "$STAGE_DIR/command.sh" <<'ZSH_EOF'
# Copy to Applications — Finder Quick Action body.
# Receives selected .app bundle paths as arguments from the services system.

TITLE="Copy to Applications"

# Post a macOS notification; a denied/blocked notification must never fail
# the whole action, hence the || true.
notify() {
  /usr/bin/osascript -e "display notification \"$1\" with title \"$TITLE\"" >/dev/null 2>&1 || true
}

for f in "$@"; do
  # NSSendFileTypes already filters to .app bundles; stay defensive anyway.
  case "$f" in
    *.app) [ -e "$f" ] || continue ;;
    *) continue ;;
  esac

  name="$(basename "$f")"
  dest="/Applications/$name"

  # Existing destination: ask the user. COPY_TO_APPS_REPLACE=1 replaces
  # without asking — DANGEROUS for running apps (rm -rf of a live bundle,
  # old copy unrecoverable) — so the dialog is the default path.
  if [ -e "$dest" ]; then
    if [ "${COPY_TO_APPS_REPLACE:-0}" = "1" ]; then
      rm -rf "$dest"
    else
      # -128 (close button/ESC) and any dialog failure keep the existing copy.
      answer="$(/usr/bin/osascript \
        -e 'on run argv' \
        -e 'display dialog (item 1 of argv & " already exists in /Applications. Replace it?") buttons {"Skip", "Replace"} default button "Replace" with icon caution with title "Copy to Applications"' \
        -e 'return button returned of result' \
        -e 'end run' \
        "$name" 2>/dev/null || echo "Skip")"
      if [ "$answer" != "Replace" ]; then
        notify "Kept the existing /Applications/$name"
        continue
      fi
      rm -rf "$dest"
    fi
  fi

  # Primary path: unprivileged copy. Works because /Applications is
  # root:admin drwxrwxr-w and the service runs as the logged-in admin user.
  if /usr/bin/ditto "$f" "$dest"; then
    notify "Copied to /Applications"
    continue
  fi

  # Fallback for locked-down machines (ACLs/MDM): clean up any partial
  # destination, then let Finder duplicate it — that raises the standard
  # macOS authentication dialog when needed.
  rm -rf "$dest" 2>/dev/null || true
  if /usr/bin/osascript -e "tell application \"Finder\" to duplicate (POSIX file \"$f\" as alias) to folder \"Applications\" of startup disk with replacing" >/dev/null 2>&1; then
    notify "Copied to /Applications"
  else
    notify "Failed to copy $name"
  fi
done

exit 0
ZSH_EOF

  # Splice the escaped command into the template, then move the finished
  # document into the staged bundle.
  splice_command_string "$STAGE_DIR/document.wflow" "$STAGE_DIR/command.sh"
  mv "$STAGE_DIR/document.wflow" "$bundle_dir/Contents/document.wflow"
  echo "Staged bundle: $bundle_dir"
}

# ---------------------------------------------------------------------------
# Modes
# ---------------------------------------------------------------------------

do_install() {
  create_bundle
  # Replace any previously installed copy of this same bundle so installs are
  # idempotent, then copy with ditto to keep bundle metadata intact.
  rm -rf "$SERVICES_DIR/$BUNDLE_NAME"
  /usr/bin/ditto "$STAGE_DIR/$BUNDLE_NAME" "$SERVICES_DIR/$BUNDLE_NAME"
  flush_services
  echo "Installed: $SERVICES_DIR/$BUNDLE_NAME"
  echo "Use it: in Finder, right-click an .app -> Quick Actions -> Copy to Applications."
  echo "Existing apps: the service asks Replace/Skip per app; set COPY_TO_APPS_REPLACE=1 to replace without asking (dangerous for running apps)."
}

do_uninstall() {
  if [ -e "$SERVICES_DIR/$BUNDLE_NAME" ]; then
    rm -rf "$SERVICES_DIR/$BUNDLE_NAME"
    echo "Removed: $SERVICES_DIR/$BUNDLE_NAME"
  else
    echo "Nothing to remove: $SERVICES_DIR/$BUNDLE_NAME not present"
  fi
  flush_services
}

self_test() {
  local out status
  local bundle_dir="$STAGE_DIR/$BUNDLE_NAME"

  # -- Step 1: generate ----------------------------------------------------
  if create_bundle; then
    echo "PASS: generate bundle into staging dir"
  else
    echo "FAIL: generate bundle into staging dir"
    return 1
  fi

  # -- Steps 2-3: lint both plists (early return; no artifacts yet) --------
  if /usr/bin/plutil -lint "$bundle_dir/Contents/Info.plist"; then
    echo "PASS: plutil -lint Info.plist"
  else
    echo "FAIL: plutil -lint Info.plist"
    return 1
  fi
  if /usr/bin/plutil -lint "$bundle_dir/Contents/document.wflow"; then
    echo "PASS: plutil -lint document.wflow"
  else
    echo "FAIL: plutil -lint document.wflow"
    return 1
  fi

  # -- Step 4: install + flush ---------------------------------------------
  if do_install; then
    echo "PASS: install to $SERVICES_DIR and flush services"
  else
    echo "FAIL: install to $SERVICES_DIR and flush services"
    return 1
  fi

  # From here on, every step runs even if an earlier one fails, so the test
  # app is always cleaned up from /Applications and /tmp.
  local failed=0

  # -- Step 5: stage a throwaway test app in /tmp ---------------------------
  # cp -R, NOT ditto: apps on the sealed system volume carry the SIP
  # `restricted` BSD flag, and unprivileged ditto fails with
  # "Operation not permitted" trying to preserve it. cp -R yields an
  # equivalent clean .app skeleton, which is all the test needs.
  rm -rf /tmp/MT4-Test.app
  if cp -R /System/Applications/Calculator.app /tmp/MT4-Test.app && [ -d /tmp/MT4-Test.app ]; then
    echo "PASS: stage test app /tmp/MT4-Test.app (cp -R from Calculator.app)"
  else
    echo "FAIL: stage test app /tmp/MT4-Test.app (cp -R from Calculator.app)"
    rm -rf /Applications/MT4-Test.app /tmp/MT4-Test.app
    return 1
  fi

  # -- Step 6: run the installed service via automator (can be slow) -------
  if out="$(/usr/bin/automator -i /tmp/MT4-Test.app "$SERVICES_DIR/$BUNDLE_NAME" 2>&1)"; then
    echo "PASS: automator -i ran the service on /tmp/MT4-Test.app"
  else
    status=$?
    echo "FAIL: automator -i ran the service on /tmp/MT4-Test.app (exit $status)"
    printf '%s\n' "$out" | sed 's/^/      /'
    failed=1
  fi

  # -- Step 7: assert the copy landed in /Applications ---------------------
  if [ -d /Applications/MT4-Test.app ]; then
    echo "PASS: /Applications/MT4-Test.app exists after service run"
  else
    echo "FAIL: /Applications/MT4-Test.app exists after service run"
    failed=1
  fi

  # -- Step 8: clean up the test app (never touches /System) ---------------
  if rm -rf /Applications/MT4-Test.app /tmp/MT4-Test.app \
    && [ ! -e /Applications/MT4-Test.app ] && [ ! -e /tmp/MT4-Test.app ]; then
    echo "PASS: cleanup removed /Applications/MT4-Test.app and /tmp/MT4-Test.app"
  else
    echo "FAIL: cleanup removed /Applications/MT4-Test.app and /tmp/MT4-Test.app"
    failed=1
  fi

  return "$failed"
}

usage() {
  echo "Usage: $(basename "$0") [--install|--uninstall|--self-test]" >&2
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

MODE="install"
case "${1:-}" in
  "") ;;
  --install) ;;
  --uninstall) MODE="uninstall" ;;
  --self-test) MODE="self-test" ;;
  -h|--help) usage; exit 0 ;;
  *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
esac

case "$MODE" in
  install) do_install ;;
  uninstall) do_uninstall ;;
  self-test)
    if self_test; then
      echo "SELF-TEST: PASS"
      exit 0
    else
      echo "SELF-TEST: FAIL"
      exit 1
    fi
    ;;
esac
