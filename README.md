# codex-chat-title-animation

Codex skill that animates a desktop chat title through Codex's local IPC.

This is an experimental macOS desktop integration. It uses an internal Codex
IPC endpoint, so a Codex update can change or remove the mechanism.

The installable skill is in `skills/codex-chat-title-animation`.

Install it as a local Codex skill:

```zsh
mkdir -p "$HOME/.codex/skills"
cp -R skills/codex-chat-title-animation "$HOME/.codex/skills/"
```
