#!/bin/bash
# Installs a user-level LaunchAgent so the JARVIS backend starts at login and
# stays up. Combined with installing the PWA (Chrome → install icon at
# http://localhost:8790), JARVIS becomes a dock app that always just works.
#
#   ./desktop/install-autostart.sh            install + start now
#   ./desktop/install-autostart.sh remove     uninstall
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/dev.umair.jarvis.plist"
# login shells can print banners before the path — keep the last line, verify it
NODE_BIN="$(/bin/zsh -lc 'which node' | tail -1)"
if [[ ! -x "$NODE_BIN" ]]; then
  for cand in /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node; do
    [[ -x "$cand" ]] && NODE_BIN="$cand" && break
  done
fi
[[ -x "$NODE_BIN" ]] || { echo "error: node not found — install Node.js first"; exit 1; }

if [[ "${1:-}" == "remove" ]]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "JARVIS autostart removed."
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.umair.jarvis</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>src/server.ts</string>
  </array>
  <key>WorkingDirectory</key><string>${REPO}/backend</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/jarvis-server.log</string>
  <key>StandardErrorPath</key><string>/tmp/jarvis-server.log</string>
</dict>
</plist>
PLIST_EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "JARVIS backend installed as a login service (dev.umair.jarvis)."
echo "It is starting now and will start automatically at every login."
echo "Next: open http://localhost:8790 in Chrome and click the install icon"
echo "in the address bar — JARVIS lands in your dock as its own app."
