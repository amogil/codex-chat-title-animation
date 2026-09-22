# codex-chat-title-animation

An experimental Codex skill for animated task titles.

The current implementation works only on macOS. It uses an internal Codex IPC
endpoint, so a Codex update can change or remove the mechanism.

## Install

```zsh
mkdir -p "$HOME/.codex/skills"
cp -R skills/codex-chat-title-animation "$HOME/.codex/skills/"
```

Restart Codex or reload its skills after installation.

## Use

Ask Codex in the target task to start the title animation. The skill keeps the
animation in a managed background terminal session. Codex returns control to
the chat without waiting for that session to finish; the animation continues
until it is stopped, the task is archived or deleted, or Codex exits.

To run it directly from a Codex task environment:

```zsh
SKILL_PATH="${CODEX_HOME:-$HOME/.codex}/skills/codex-chat-title-animation"
zsh "$SKILL_PATH/scripts/codex-title-animation.sh" start "$CODEX_THREAD_ID" "Running tests" "wizard"
zsh "$SKILL_PATH/scripts/codex-title-animation.sh" start "$CODEX_THREAD_ID" "Reviewing changes"
zsh "$SKILL_PATH/scripts/codex-title-animation.sh" stop "$CODEX_THREAD_ID"
```

`start` prints the animation PID and then intentionally keeps running in the
terminal session. When Codex invokes it, that terminal session must be left
running in the background rather than awaited to completion. A repeated start
replaces the existing animation for that task. Its optional second argument is
a short model-generated description of the current work. Codex always derives
and supplies it from the current task without asking the user; it remains
optional only for manual CLI calls. Animation frames may contain the
`{work}` placeholder, which is replaced with this description. If no
description is supplied, the placeholder is removed. The
optional third argument is an animation name from the skill's `animations/`
directory. Animation files have no extension, so pass `wizard` or
`rocket-launch` exactly as shown in the directory. Without a name, the first
animation in alphabetical order is used. If the only optional argument exactly
matches an animation name, it is still treated as the work description. For a
manual start with no work description, pass an empty second argument:
`start THREAD_ID "" wizard`.
Each line uses `FRAME DELAY_SECONDS`, for example
`o>............ {work} 1` or `done {work} 2.5`.
The delay may be any number from 1 to 60 seconds. Frames are played in file
order and repeat in a loop. Blank lines and the old frame-only format are not
supported. The `{work}` placeholder is optional and may appear more than once
in a frame. `stop` only signals the
matching tracked animation process; it will not signal an unrelated process
that reused the PID. The process stops itself when the thread is archived or
can no longer be read.

Temporary IPC failures are retried silently after 1, 2, and 4 seconds. If all
three retries fail, the process prints one final error and exits; it does not
produce an unbounded stream of retry messages.

Animations are isolated by thread id. Any number of different tasks can run
animations concurrently, while repeated starts in one task always replace that
task's previous animation.

The launcher uses Node bundled with Codex, so no system Node.js installation is
required. The managed terminal session is part of the animation lifetime; do
not close it unless the animation should stop. This is an internal IPC
integration and may need adjustment after a Codex update.
