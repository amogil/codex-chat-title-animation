---
name: codex-chat-title-animation
description: Start or stop a non-blocking animated title in the current macOS Codex desktop task. Use only when the user explicitly asks to animate or stop animating a task title.
---

# Codex chat title animation

Use this skill only for an explicit request to animate a task title in macOS
Codex desktop. It relies on internal local IPC and is experimental.

The script has two actions. Both return immediately:

```zsh
SKILL_PATH="${CODEX_HOME:-$HOME/.codex}/skills/codex-chat-title-animation"
zsh "$SKILL_PATH/scripts/codex-title-animation.sh" start "$CODEX_THREAD_ID"
zsh "$SKILL_PATH/scripts/codex-title-animation.sh" stop "$CODEX_THREAD_ID"
```

- `start` creates a detached process and prints its PID. If the same task is
  already animated, it leaves that animation running and reports its PID.
- `stop` terminates only the tracked animation for that task. It is safe when
  no animation is running.

Before `start`, confirm that `CODEX_THREAD_ID` is non-empty. Report that the
animation continues independently after the command returns. To stop it, run
the `stop` command above. Do not use this skill for persistent production
automation or to change a task title without the user's request.
