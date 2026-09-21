---
name: codex-chat-title-animation
description: Start or stop a non-blocking animated title in the current Codex task. Use when the user asks to animate or stop animating a task title.
---

# Codex chat title animation

Use this skill only for an explicit request to animate a Codex task title. It
relies on internal local IPC and is experimental.

The script has two actions. Both return immediately:

```zsh
SKILL_PATH="${CODEX_HOME:-$HOME/.codex}/skills/codex-chat-title-animation"
zsh "$SKILL_PATH/scripts/codex-title-animation.sh" start "$CODEX_THREAD_ID" "Running tests" "wizard.txt"
zsh "$SKILL_PATH/scripts/codex-title-animation.sh" start "$CODEX_THREAD_ID" "Reviewing changes"
zsh "$SKILL_PATH/scripts/codex-title-animation.sh" stop "$CODEX_THREAD_ID"
```

- `start` creates a detached process and prints its PID. If the same task is
  already animated, it replaces the earlier animation with a new process.
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
- `stop` terminates only the tracked animation for that task. It is safe when
  no animation is running.

Before `start`, confirm that `CODEX_THREAD_ID` is non-empty. Always generate and
pass a current-work description from the task context. Never ask the user to
provide it. Report that the animation continues independently after the
command returns. To stop it, run the `stop` command above. Do not use this skill
for persistent production automation or to change a task title without the
user's request.
