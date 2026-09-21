---
name: codex-chat-title-animation
description: Start or stop an animated title in the current Codex task using a managed background terminal session. Use when the user asks to animate or stop animating a task title.
---

# Codex chat title animation

Use this skill only for an explicit request to animate a Codex task title. It
relies on internal local IPC and is experimental.

The script has two actions:

```zsh
SKILL_PATH="${CODEX_HOME:-$HOME/.codex}/skills/codex-chat-title-animation"
zsh "$SKILL_PATH/scripts/codex-title-animation.sh" start "$CODEX_THREAD_ID" "Running tests" "wizard.txt"
zsh "$SKILL_PATH/scripts/codex-title-animation.sh" start "$CODEX_THREAD_ID" "Reviewing changes"
zsh "$SKILL_PATH/scripts/codex-title-animation.sh" stop "$CODEX_THREAD_ID"
```

- `start` prints its PID and intentionally remains running. Invoke it in a
  terminal with a short initial yield. When the terminal tool returns a running
  session, leave that session active and do not wait for completion. From the
  user's perspective the start is non-blocking. If the same task is already
  animated, the new terminal session signals and replaces the earlier one.
- Different tasks may animate concurrently, but each task has exactly one
  current animation process tracked by its thread id.
- `current-work` is an optional short description of the task or stage the
  model is currently working on, such as `Running tests`. Whenever the model
  starts an animation, it must derive and pass this description from the
  current chat without asking the user. Prefer a concrete phrase of two to six
  words. The argument remains optional only for manual CLI compatibility. It
  is reserved for future title composition and is not used by the current
  implementation.
- `animation-file` is an optional `.txt` filename from `animations/`. Each line
  uses `FRAME DELAY_SECONDS`; the numeric delay must be from 1 to 60 seconds.
  Without a filename, use the first file in alphabetical order. When the only
  optional argument ends in `.txt`, the script treats it as `animation-file`
  and leaves `current-work` empty.
- `stop` returns immediately after terminating only the tracked animation
  session for that task. It is safe when no animation is running.

Before `start`, confirm that `CODEX_THREAD_ID` is non-empty. Always generate and
pass a current-work description from the task context. Never ask the user to
provide it. After the terminal tool yields a running session, report that the
animation continues in that managed session. Do not poll or wait on it. To stop
it, run the `stop` command above; the original terminal session should then
finish. Do not use this skill for persistent production automation or to change
a task title without the user's request.
