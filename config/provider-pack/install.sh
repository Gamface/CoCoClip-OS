#!/bin/sh
# Fills Paperclip's ACPX provider pack volume from config/provider-pack/package.json.
# Runs once before Paperclip starts; skips the install when the volume already matches.
set -eu
dest=/opt/paperclip-runner/provider-pack
src=/provider-pack-src/package.json
if cmp -s "$src" "$dest/package.json" && [ -d "$dest/node_modules/@agentclientprotocol/claude-agent-acp" ]; then
  echo "provider pack is up to date"
  exit 0
fi
echo "installing provider pack into $dest"
rm -rf "$dest/node_modules" "$dest/package-lock.json"
cp "$src" "$dest/package.json"
cd "$dest"
npm install --omit=dev --no-audit --no-fund --loglevel=error
chown -R node:node "$dest"
echo "provider pack installed"
