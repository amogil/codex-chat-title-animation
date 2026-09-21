#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const PIPE_ENVIRONMENT_VARIABLE = "CODEX_APP_TOOLS_PIPE_PATH";
const DEFAULT_ANIMATION_DIRECTORY = fileURLToPath(new URL("../animations/", import.meta.url));

export function listAnimationFiles(animationDirectory = DEFAULT_ANIMATION_DIRECTORY) {
  let files;
  try {
    files = readdirSync(animationDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".txt"))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    throw new Error(`Could not read animation directory: ${error.message}`);
  }
  if (files.length === 0) throw new Error("No animation files were found.");
  return files;
}

export function resolveAnimation(animationFile, animationDirectory = DEFAULT_ANIMATION_DIRECTORY) {
  const files = listAnimationFiles(animationDirectory);
  const selectedFile = animationFile || files[0];
  if (!files.includes(selectedFile)) throw new Error(`Animation file was not found: ${selectedFile}`);
  const contents = readFileSync(path.join(animationDirectory, selectedFile), "utf8");
  const lines = contents.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines.every((line) => line.length === 0)) {
    throw new Error(`Animation file has no frames: ${selectedFile}`);
  }
  const steps = lines.map((line, index) => {
    const match = line.match(/^(.*\S)\s+([0-9]+(?:\.[0-9]+)?)\s*$/);
    if (!match) throw new Error(`Invalid animation line ${index + 1} in ${selectedFile}: expected FRAME DELAY_SECONDS`);
    const delaySeconds = Number(match[2]);
    if (delaySeconds < 1 || delaySeconds > 60) {
      throw new Error(`Invalid delay on line ${index + 1} in ${selectedFile}: expected a value from 1 to 60 seconds`);
    }
    return { frame: match[1], delaySeconds };
  });
  return { fileName: selectedFile, steps };
}

function stateDirectory(environment = process.env) {
  return environment.CODEX_TITLE_ANIMATION_STATE_DIR || path.join(os.tmpdir(), "codex-chat-title-animation");
}

function statePath(threadId, environment = process.env) {
  return path.join(stateDirectory(environment), `${encodeURIComponent(threadId)}.json`);
}

function readState(threadId, environment = process.env) {
  try {
    return JSON.parse(readFileSync(statePath(threadId, environment), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Could not read animation state: ${error.message}`);
  }
}

function writeState(threadId, state, environment = process.env) {
  mkdirSync(stateDirectory(environment), { recursive: true, mode: 0o700 });
  writeFileSync(statePath(threadId, environment), `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

function removeState(threadId, runId, environment = process.env) {
  const state = readState(threadId, environment);
  if (state?.runId === runId) rmSync(statePath(threadId, environment), { force: true });
}

function isCurrentRun(threadId, runId, environment = process.env) {
  return readState(threadId, environment)?.runId === runId;
}

function isRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "EPERM") return true;
    return false;
  }
}

function processCommand(pid) {
  return commandOutput("ps", ["-o", "command=", "-p", String(pid)]).trim();
}

function isTrackedAnimation(state, dependencies = {}) {
  const processIsRunning = dependencies.isRunning || isRunning;
  if (!state || !processIsRunning(state.pid)) return false;
  const command = dependencies.processCommand ? dependencies.processCommand(state) : processCommand(state.pid);
  return typeof state.processTitle === "string" && command.includes(state.processTitle);
}

function commandOutput(command, argumentsValue) {
  try {
    return execFileSync(command, argumentsValue, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

export function findPipePath(environment = process.env, dependencies = {}) {
  const getCommandOutput = dependencies.commandOutput || commandOutput;
  const getStats = dependencies.statSync || statSync;
  const explicitPath = environment[PIPE_ENVIRONMENT_VARIABLE];
  if (explicitPath) {
    try {
      if (getStats(explicitPath).isSocket()) return explicitPath;
    } catch {
      // Fall back to discovering the running desktop host.
    }
  }
  const processIds = getCommandOutput("pgrep", ["-f", "cua_node/bin/node ./server\\.mjs"]).split("\n").filter(Boolean);
  const pattern = new RegExp(`(?:^|\\s)${PIPE_ENVIRONMENT_VARIABLE}=([^\\s]+)`);
  const paths = new Set();
  for (const processId of processIds) {
    const match = getCommandOutput("ps", ["eww", "-p", processId]).match(pattern);
    if (!match) continue;
    try {
      if (getStats(match[1]).isSocket()) paths.add(match[1]);
    } catch {
      // The socket can disappear while Codex restarts.
    }
  }
  const values = [...paths].sort();
  if (values.length === 1) return values[0];
  if (values.length > 1) throw new Error(`More than one Codex desktop IPC pipe was found: ${values.join(", ")}`);
  throw new Error("No active Codex desktop IPC pipe was found. Open Codex desktop, then try again.");
}

export function request(pipePath, method, params, timeoutMilliseconds = 5000) {
  const payload = Buffer.from(JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }), "utf8");
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const connection = net.createConnection(pipePath);
    connection.setTimeout(timeoutMilliseconds);
    connection.once("connect", () => connection.write(frame));
    connection.on("data", (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.length < 4) return;
      const length = data.readUInt32LE(0);
      if (data.length < length + 4) return;
      connection.end();
      try {
        const response = JSON.parse(data.subarray(4, length + 4).toString("utf8"));
        if (response.error) settle(reject, new Error(`Codex desktop returned an error: ${JSON.stringify(response.error)}`));
        else settle(resolve, response.result);
      } catch (error) {
        settle(reject, error);
      }
    });
    connection.once("timeout", () => connection.destroy(new Error("Timed out waiting for Codex desktop IPC pipe.")));
    connection.once("error", (error) => settle(reject, error));
    connection.once("close", () => {
      if (!settled) settle(reject, new Error("Codex desktop IPC pipe closed before sending a complete response."));
    });
  });
}

export async function setTitle(pipePath, threadId, title) {
  const listed = await request(pipePath, "tools/list", { threadStartKind: "all" });
  const tool = listed.tools?.find((candidate) => candidate.name === "set_thread_title");
  if (!tool?.namespace) throw new Error("The running Codex desktop app does not expose set_thread_title.");
  const result = await request(pipePath, "tools/call", {
    namespace: tool.namespace,
    tool: "set_thread_title",
    threadId,
    callId: `title-animation-${randomUUID()}`,
    turnId: `title-animation-turn-${randomUUID()}`,
    arguments: { title }
  });
  if (!result.success) throw new Error("Codex desktop did not confirm the title update.");
}

export async function readThread(pipePath, threadId) {
  const result = await request(pipePath, "tools/call", {
    namespace: "codex_app",
    tool: "read_thread",
    threadId,
    callId: `title-animation-read-${randomUUID()}`,
    turnId: `title-animation-read-turn-${randomUUID()}`,
    arguments: { threadId, turnLimit: 1 }
  });
  if (!result.success) throw new Error("Codex desktop did not confirm the thread read.");
  const content = result.contentItems?.find((item) => typeof item.text === "string")?.text;
  if (!content) throw new Error("Codex desktop returned no thread data.");
  try {
    return JSON.parse(content).thread;
  } catch (error) {
    throw new Error(`Codex desktop returned invalid thread data: ${error.message}`);
  }
}

export async function runAnimation(threadId, runId, environment = process.env, dependencies = {}, animationFile) {
  let stopping = false;
  let cancelDelay;
  const stop = () => {
    stopping = true;
    cancelDelay?.();
  };
  const signalTarget = dependencies.signalTarget || process;
  signalTarget.once("SIGTERM", stop);
  signalTarget.once("SIGINT", stop);
  try {
    const pipePath = (dependencies.findPipePath || findPipePath)(environment);
    const updateTitle = dependencies.setTitle || setTitle;
    const getThread = dependencies.readThread || readThread;
    const runIsCurrent = dependencies.isCurrentRun || isCurrentRun;
    const sleep = dependencies.sleep || ((milliseconds) => new Promise((resolve) => {
      const finish = () => {
        cancelDelay = undefined;
        resolve();
      };
      const timer = setTimeout(finish, milliseconds);
      cancelDelay = () => {
        clearTimeout(timer);
        finish();
      };
    }));
    const steps = dependencies.steps || (dependencies.resolveAnimation || resolveAnimation)(animationFile, dependencies.animationDirectory).steps;
    let frameIndex = 0;
    while (!stopping) {
      if (!runIsCurrent(threadId, runId, environment)) return;
      const thread = await getThread(pipePath, threadId);
      if (stopping || !runIsCurrent(threadId, runId, environment)) return;
      if (thread?.status?.type !== "active") return;
      const step = steps[frameIndex % steps.length];
      await updateTitle(pipePath, threadId, step.frame);
      frameIndex += 1;
      if (!stopping) await sleep(step.delaySeconds * 1000);
    }
  } finally {
    signalTarget.removeListener("SIGTERM", stop);
    signalTarget.removeListener("SIGINT", stop);
    removeState(threadId, runId, environment);
  }
}

export function startAnimation(threadId, environment = process.env, dependencies = {}, animationFile) {
  if (!threadId) throw new Error("Usage: codex-title-animation start THREAD_ID");
  const selectedAnimation = (dependencies.resolveAnimation || resolveAnimation)(animationFile, dependencies.animationDirectory);
  const read = dependencies.readState || readState;
  const write = dependencies.writeState || writeState;
  const kill = dependencies.kill || process.kill;
  const previous = read(threadId, environment);
  const runId = randomUUID();
  const scriptPath = path.resolve(process.argv[1]);
  const previousIsTracked = isTrackedAnimation(previous, dependencies);
  if (previousIsTracked) {
    try {
      kill(previous.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  const pid = (dependencies.getPid || (() => process.pid))();
  const processTitle = `codex-title-animation:${threadId}:${runId}`;
  (dependencies.setProcessTitle || ((title) => { process.title = title; }))(processTitle, pid);
  write(threadId, { pid, runId, threadId, scriptPath, processTitle, animationFile: selectedAnimation.fileName }, environment);
  return { started: true, pid, runId, animationFile: selectedAnimation.fileName };
}

export function stopAnimation(threadId, environment = process.env, dependencies = {}) {
  if (!threadId) throw new Error("Usage: codex-title-animation stop THREAD_ID");
  const read = dependencies.readState || readState;
  const remove = dependencies.removeState || removeState;
  const state = read(threadId, environment);
  if (!isTrackedAnimation(state, dependencies)) {
    if (state) remove(threadId, state.runId, environment);
    return { stopped: false, pid: null };
  }
  try {
    (dependencies.kill || process.kill)(state.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    remove(threadId, state.runId, environment);
  }
  return { stopped: true, pid: state.pid };
}

export async function main(argumentsValue = process.argv.slice(2), environment = process.env, dependencies = {}) {
  const [action, threadId] = argumentsValue;
  const start = dependencies.startAnimation || startAnimation;
  const stop = dependencies.stopAnimation || stopAnimation;
  const run = dependencies.runAnimation || runAnimation;
  const log = dependencies.log || console.log;
  if (action === "start") {
    if (!threadId || argumentsValue.length < 2 || argumentsValue.length > 4) {
      throw new Error("Usage: codex-title-animation start THREAD_ID [CURRENT_WORK] [ANIMATION_FILE]");
    }
    const optionalArguments = argumentsValue.slice(2);
    const animationFile = optionalArguments.length === 1 && optionalArguments[0].endsWith(".txt")
      ? optionalArguments[0]
      : optionalArguments[1];
    const animationDependencies = dependencies.animationDependencies || {};
    const result = start(threadId, environment, animationDependencies, animationFile);
    log(`Animation session started (PID ${result.pid}). Keep this terminal session running.`);
    await run(threadId, result.runId, environment, animationDependencies, result.animationFile);
    return;
  }
  if (action === "stop") {
    if (!threadId || argumentsValue.length !== 2) throw new Error("Usage: codex-title-animation stop THREAD_ID");
    const result = stop(threadId, environment, dependencies.animationDependencies || {});
    log(result.stopped ? `Animation stop requested (PID ${result.pid}).` : "No tracked animation is running.");
    return;
  }
  if (action === "run") {
    const [, , animationFile, runId] = argumentsValue;
    if (!threadId || !animationFile || !runId || argumentsValue.length !== 4) {
      throw new Error("Usage: codex-title-animation run THREAD_ID ANIMATION_FILE RUN_ID");
    }
    await run(threadId, runId, environment, dependencies.animationDependencies || {}, animationFile);
    return;
  }
  throw new Error("Usage: codex-title-animation start THREAD_ID [CURRENT_WORK] [ANIMATION_FILE] | stop THREAD_ID");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Title animation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
