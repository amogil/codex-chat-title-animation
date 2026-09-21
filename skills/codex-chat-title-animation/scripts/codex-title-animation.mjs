#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const FRAMES = ["o>....", ".o>...", "..o>..", "...o>.", "....o>", "...<o.", "..<o..", ".<o..."];
export const FRAME_INTERVAL_MILLISECONDS = 1000;
const PIPE_ENVIRONMENT_VARIABLE = "CODEX_APP_TOOLS_PIPE_PATH";

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
  if (!state || !isRunning(state.pid)) return false;
  const command = dependencies.processCommand ? dependencies.processCommand(state) : processCommand(state.pid);
  return command.includes(state.scriptPath) && command.includes(" run ") && command.includes(state.runId);
}

function commandOutput(command, argumentsValue) {
  try {
    return execFileSync(command, argumentsValue, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

export function findPipePath(environment = process.env) {
  const explicitPath = environment[PIPE_ENVIRONMENT_VARIABLE];
  if (explicitPath) {
    try {
      if (statSync(explicitPath).isSocket()) return explicitPath;
    } catch {
      // Fall back to discovering the running desktop host.
    }
  }
  const processIds = commandOutput("pgrep", ["-f", "cua_node/bin/node ./server\\.mjs"]).split("\n").filter(Boolean);
  const pattern = new RegExp(`(?:^|\\s)${PIPE_ENVIRONMENT_VARIABLE}=([^\\s]+)`);
  const paths = new Set();
  for (const processId of processIds) {
    const match = commandOutput("ps", ["eww", "-p", processId]).match(pattern);
    if (!match) continue;
    try {
      if (statSync(match[1]).isSocket()) paths.add(match[1]);
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

export async function runAnimation(threadId, runId, environment = process.env, dependencies = {}) {
  const pipePath = (dependencies.findPipePath || findPipePath)(environment);
  const updateTitle = dependencies.setTitle || setTitle;
  const sleep = dependencies.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let frameIndex = 0;
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    while (!stopping) {
      await updateTitle(pipePath, threadId, FRAMES[frameIndex % FRAMES.length]);
      frameIndex += 1;
      if (!stopping) await sleep(FRAME_INTERVAL_MILLISECONDS);
    }
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    removeState(threadId, runId, environment);
  }
}

export function startAnimation(threadId, environment = process.env, dependencies = {}) {
  if (!threadId) throw new Error("Usage: codex-title-animation start THREAD_ID");
  const previous = readState(threadId, environment);
  if (isTrackedAnimation(previous, dependencies)) return { started: false, pid: previous.pid };
  if (previous) removeState(threadId, previous.runId, environment);
  const runId = randomUUID();
  const spawnProcess = dependencies.spawn || spawn;
  const child = spawnProcess(process.execPath, [path.resolve(process.argv[1]), "run", threadId, runId], {
    detached: true,
    stdio: "ignore",
    env: environment
  });
  child.unref();
  writeState(threadId, { pid: child.pid, runId, threadId, scriptPath: path.resolve(process.argv[1]) }, environment);
  return { started: true, pid: child.pid };
}

export function stopAnimation(threadId, environment = process.env, dependencies = {}) {
  if (!threadId) throw new Error("Usage: codex-title-animation stop THREAD_ID");
  const state = readState(threadId, environment);
  if (!isTrackedAnimation(state, dependencies)) {
    if (state) removeState(threadId, state.runId, environment);
    return { stopped: false, pid: null };
  }
  (dependencies.kill || process.kill)(state.pid, "SIGTERM");
  return { stopped: true, pid: state.pid };
}

export async function main(argumentsValue = process.argv.slice(2), environment = process.env) {
  const [action, threadId, runId] = argumentsValue;
  if (action === "start") {
    const result = startAnimation(threadId, environment);
    console.log(result.started ? `Animation started (PID ${result.pid}).` : `Animation is already running (PID ${result.pid}).`);
    return;
  }
  if (action === "stop") {
    const result = stopAnimation(threadId, environment);
    console.log(result.stopped ? `Animation stop requested (PID ${result.pid}).` : "No tracked animation is running.");
    return;
  }
  if (action === "run" && threadId && runId) {
    await runAnimation(threadId, runId, environment);
    return;
  }
  throw new Error("Usage: codex-title-animation <start|stop> THREAD_ID");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Title animation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
