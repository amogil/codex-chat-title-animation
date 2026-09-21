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
zsh "$SKILL_PATH/scripts/codex-title-animation.sh" start "$CODEX_THREAD_ID" "Running tests" "wizard.txt"
zsh "$SKILL_PATH/scripts/codex-title-animation.sh" start "$CODEX_THREAD_ID" "Reviewing changes"
zsh "$SKILL_PATH/scripts/codex-title-animation.sh" stop "$CODEX_THREAD_ID"
```

`start` prints the animation PID and then intentionally keeps running in the
terminal session. When Codex invokes it, that terminal session must be left
running in the background rather than awaited to completion. A repeated start
replaces the existing animation for that task. Its optional second argument is
a short model-generated description of
the current work. The description is accepted for forward compatibility but
is not used yet. Codex always derives and supplies it from the current task
without asking the user; it remains optional only for manual CLI calls. The
optional third argument is a filename from the skill's `animations/` directory.
Without it, the first `.txt` file in alphabetical order is used. If the only
optional argument ends in `.txt`, it is interpreted as the animation filename
rather than the work description.
Each line uses `FRAME DELAY_SECONDS`, for example `o>.... 1` or `done 2.5`.
The delay may be any number from 1 to 60 seconds. Frames are played in file
order and repeat in a loop. Blank lines and the old frame-only format are not
supported. `stop` only signals the
matching tracked animation process; it will not signal an unrelated process
that reused the PID. The process stops itself when the thread is archived or
can no longer be read.

Animations are isolated by thread id. Any number of different tasks can run
animations concurrently, while repeated starts in one task always replace that
task's previous animation.

The launcher uses Node bundled with Codex, so no system Node.js installation is
required. The managed terminal session is part of the animation lifetime; do
not close it unless the animation should stop. This is an internal IPC
integration and may need adjustment after a Codex update.
