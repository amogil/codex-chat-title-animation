#!/bin/zsh
set -euo pipefail

SCRIPT_DIRECTORY="${0:A:h}"
SCRIPT_PATH="$SCRIPT_DIRECTORY/codex-title-animation.mjs"

if [[ -n "${CODEX_MCP_NODE_PATH:-}" && -x "$CODEX_MCP_NODE_PATH" ]]; then
  exec "$CODEX_MCP_NODE_PATH" "$SCRIPT_PATH" "$@"
fi

for candidate in \
  /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node \
  /Applications/Codex.app/Contents/Resources/cua_node/bin/node; do
  if [[ -x "$candidate" ]]; then
    exec "$candidate" "$SCRIPT_PATH" "$@"
  fi
done

while IFS= read -r candidate; do
  if [[ -x "$candidate" ]]; then
    exec "$candidate" "$SCRIPT_PATH" "$@"
  fi
done < <(find /Applications -maxdepth 7 -type f -path '*/Contents/Resources/*/bin/node' 2>/dev/null)

print -u2 'Codex bundled Node was not found. Open the macOS Codex desktop app and try again.'
exit 1
