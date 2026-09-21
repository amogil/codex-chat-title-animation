# codex-chat-title-animation

An experimental Codex skill that animates a macOS desktop task title through
Codex's local IPC.

This is an experimental macOS desktop integration. It uses an internal Codex
IPC endpoint, so a Codex update can change or remove the mechanism.

## Install

```zsh
mkdir -p "$HOME/.codex/skills"
cp -R skills/codex-chat-title-animation "$HOME/.codex/skills/"
```

Restart Codex or reload its skills after installation.

## Use

Ask Codex in the target task to start the title animation. The skill starts a
detached process and immediately returns; the animation continues until it is
stopped or Codex exits.

To run it directly from a Codex task environment:

```zsh
SKILL_PATH="${CODEX_HOME:-$HOME/.codex}/skills/codex-chat-title-animation"
zsh "$SKILL_PATH/scripts/codex-title-animation.sh" start "$CODEX_THREAD_ID"
zsh "$SKILL_PATH/scripts/codex-title-animation.sh" stop "$CODEX_THREAD_ID"
```

`start` prints the animation PID. `stop` only signals the matching tracked
animation process; it will not signal an unrelated process that reused the PID.

The launcher uses Node bundled with Codex, so no system Node.js installation is
required. This is an internal IPC integration and may need adjustment after a
Codex update.
