import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FRAMES, request, runAnimation, setTitle, startAnimation, stopAnimation } from "../scripts/codex-title-animation.mjs";

function temporaryEnvironment() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-title-animation-test-"));
  return { CODEX_TITLE_ANIMATION_STATE_DIR: directory };
}

test("request uses little-endian length framing and parses a response", async (t) => {
  const socketPath = path.join(mkdtempSync(path.join(os.tmpdir(), "codex-title-animation-socket-")), "ipc.sock");
  const server = net.createServer((connection) => connection.once("data", (data) => {
    const size = data.readUInt32LE(0);
    const requestValue = JSON.parse(data.subarray(4, size + 4));
    assert.equal(requestValue.method, "tools/list");
    const response = Buffer.from(JSON.stringify({ id: 1, result: { tools: [] } }));
    const frame = Buffer.alloc(response.length + 4);
    frame.writeUInt32LE(response.length, 0);
    response.copy(frame, 4);
    connection.write(frame);
  }));
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => server.close());
  assert.deepEqual(await request(socketPath, "tools/list", { threadStartKind: "all" }), { tools: [] });
});

test("setTitle discovers the namespace and sends the selected title", async (t) => {
  const socketPath = path.join(mkdtempSync(path.join(os.tmpdir(), "codex-title-animation-socket-")), "ipc.sock");
  const messages = [];
  const server = net.createServer((connection) => connection.on("data", (data) => {
    const body = JSON.parse(data.subarray(4, 4 + data.readUInt32LE(0)));
    messages.push(body);
    const result = body.method === "tools/list" ? { tools: [{ name: "set_thread_title", namespace: "codex_app" }] } : { success: true };
    const response = Buffer.from(JSON.stringify({ id: 1, result }));
    const frame = Buffer.alloc(response.length + 4);
    frame.writeUInt32LE(response.length, 0);
    response.copy(frame, 4);
    connection.write(frame);
  }));
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => server.close());
  await setTitle(socketPath, "thread-42", "o>....");
  assert.equal(messages[1].params.namespace, "codex_app");
  assert.equal(messages[1].params.threadId, "thread-42");
  assert.equal(messages[1].params.arguments.title, "o>....");
});

test("runAnimation advances through frames", async () => {
  const titles = [];
  await assert.rejects(
    runAnimation("thread-42", "test-run", {}, {
      findPipePath: () => "unused",
      setTitle: async (_pipe, _thread, title) => {
        titles.push(title);
        if (titles.length === 3) throw new Error("stop test loop");
      },
      sleep: async () => {}
    }),
    /stop test loop/
  );
  assert.deepEqual(titles, FRAMES.slice(0, 3));
});

test("start is non-blocking and repeated start reuses the tracked process", (t) => {
  const environment = temporaryEnvironment();
  t.after(() => rmSync(environment.CODEX_TITLE_ANIMATION_STATE_DIR, { recursive: true, force: true }));
  const child = { pid: process.pid, unrefCalled: false, unref() { this.unrefCalled = true; } };
  const dependencies = { spawn: () => child, processCommand: (state) => `${state.scriptPath} run thread-42 ${state.runId}` };
  assert.deepEqual(startAnimation("thread-42", environment, dependencies), { started: true, pid: process.pid });
  assert.equal(child.unrefCalled, true);
  assert.deepEqual(startAnimation("thread-42", environment, dependencies), { started: false, pid: process.pid });
});

test("stop requests SIGTERM only for the tracked animation", (t) => {
  const environment = temporaryEnvironment();
  t.after(() => rmSync(environment.CODEX_TITLE_ANIMATION_STATE_DIR, { recursive: true, force: true }));
  const child = { pid: process.pid, unref() {} };
  const dependencies = { spawn: () => child, processCommand: (state) => `${state.scriptPath} run thread-42 ${state.runId}` };
  startAnimation("thread-42", environment, dependencies);
  let signal;
  assert.deepEqual(stopAnimation("thread-42", environment, { ...dependencies, kill: (_pid, requestedSignal) => { signal = requestedSignal; } }), { stopped: true, pid: process.pid });
  assert.equal(signal, "SIGTERM");
});

test("stop ignores a state file whose PID belongs to another process", (t) => {
  const environment = temporaryEnvironment();
  t.after(() => rmSync(environment.CODEX_TITLE_ANIMATION_STATE_DIR, { recursive: true, force: true }));
  const child = { pid: process.pid, unref() {} };
  startAnimation("thread-42", environment, { spawn: () => child, processCommand: (state) => `${state.scriptPath} run thread-42 ${state.runId}` });
  let killCalled = false;
  const result = stopAnimation("thread-42", environment, {
    processCommand: () => "/Applications/Other.app/Contents/MacOS/Other",
    kill: () => { killCalled = true; }
  });
  assert.deepEqual(result, { stopped: false, pid: null });
  assert.equal(killCalled, false);
});
