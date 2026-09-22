import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { listAnimations, findPipePath, isTransientIpcError, main, readThread, renderFrame, request, resolveAnimation, runAnimation, setTitle, startAnimation, stopAnimation } from "../scripts/codex-title-animation.mjs";

const scriptPath = new URL("../scripts/codex-title-animation.mjs", import.meta.url);

function temporaryEnvironment() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-title-animation-test-"));
  return { CODEX_TITLE_ANIMATION_STATE_DIR: directory };
}

function readAnimationState(environment, threadId) {
  const file = path.join(environment.CODEX_TITLE_ANIMATION_STATE_DIR, `${encodeURIComponent(threadId)}.json`);
  return JSON.parse(readFileSync(file, "utf8"));
}

function fakeSessionManager() {
  let nextPid = 4100;
  const running = new Map();
  const killed = [];
  return {
    dependencies: {
      getPid: () => ++nextPid,
      setProcessTitle: (title, pid) => running.set(pid, title),
      isRunning: (pid) => running.has(pid),
      processCommand: (state) => running.get(state.pid) || "",
      resolveAnimation: (name) => ({ name: name || "ping-pong", steps: [{ frame: "frame", delaySeconds: 1 }] }),
      kill: (pid, signal) => {
        killed.push({ pid, signal });
        if (!running.delete(pid)) throw Object.assign(new Error("already gone"), { code: "ESRCH" });
      }
    },
    killed,
    running
  };
}

function responseFrame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const frame = Buffer.alloc(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

async function temporarySocketServer(t, handler) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-title-animation-socket-"));
  const socketPath = path.join(directory, "ipc.sock");
  const server = net.createServer(handler);
  const connections = new Set();
  server.on("connection", (connection) => {
    connections.add(connection);
    connection.once("close", () => connections.delete(connection));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(async () => {
    for (const connection of connections) connection.destroy();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  return socketPath;
}

test("animation files are sorted and the first file is the default", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-title-animation-files-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(path.join(directory, "z-last"), "z1 1\nz2 2.5\n");
  writeFileSync(path.join(directory, "a-first"), "a1 1\na2 60\n");
  writeFileSync(path.join(directory, "ignored.md"), "ignored\n");

  assert.deepEqual(listAnimations(directory), ["a-first", "z-last"]);
  assert.deepEqual(resolveAnimation(undefined, directory), {
    name: "a-first",
    steps: [{ frame: "a1", delaySeconds: 1 }, { frame: "a2", delaySeconds: 60 }]
  });
  assert.deepEqual(resolveAnimation("z-last", directory), {
    name: "z-last",
    steps: [{ frame: "z1", delaySeconds: 1 }, { frame: "z2", delaySeconds: 2.5 }]
  });
});

test("animation files reject unknown paths and invalid lines", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-title-animation-files-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(path.join(directory, "empty"), "\n\n");

  assert.throws(() => resolveAnimation("../outside", directory), /not found/);
  assert.throws(() => resolveAnimation("missing", directory), /not found/);
  assert.throws(() => resolveAnimation("empty", directory), /no frames/);
  writeFileSync(path.join(directory, "legacy"), "frame-without-delay\n");
  assert.throws(() => resolveAnimation("legacy", directory), /expected FRAME DELAY_SECONDS/);
  writeFileSync(path.join(directory, "blank"), "frame 1\n\nframe 2\n");
  assert.throws(() => resolveAnimation("blank", directory), /line 2/);
  writeFileSync(path.join(directory, "too-short"), "frame 0.5\n");
  assert.throws(() => resolveAnimation("too-short", directory), /from 1 to 60/);
  writeFileSync(path.join(directory, "too-long"), "frame 61\n");
  assert.throws(() => resolveAnimation("too-long", directory), /from 1 to 60/);
});

test("animation parser supports CRLF, spaces inside frames, and padded separators", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-title-animation-files-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(path.join(directory, "spaced"), "hello world    1.25\r\nnext frame\t60\r\n");

  assert.deepEqual(resolveAnimation("spaced", directory), {
    name: "spaced",
    steps: [
      { frame: "hello world", delaySeconds: 1.25 },
      { frame: "next frame", delaySeconds: 60 }
    ]
  });
});

test("renderFrame inserts current work and removes an unused trailing placeholder", () => {
  assert.equal(renderFrame("<<< {work} >>> {work}", "Running $& tests"), "<<< Running $& tests >>> Running $& tests");
  assert.equal(renderFrame("rocket launch {work}"), "rocket launch");
  assert.equal(renderFrame("no placeholder", "ignored"), "no placeholder");
});

test("bundled animations are wide and include the current-work placeholder", () => {
  for (const name of listAnimations()) {
    const animation = resolveAnimation(name);
    for (const step of animation.steps) {
      assert.match(step.frame, /\{work\}/, `${name} must include {work} in every frame`);
      assert.ok(step.frame.replace("{work}", "").trim().length >= 16, `${name} frames must be visually wide`);
    }
  }
});

test("animation directory must exist and contain at least one extensionless animation", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-title-animation-files-"));
  const missingDirectory = path.join(directory, "missing");
  const nestedDirectory = path.join(directory, "nested");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(nestedDirectory);
  writeFileSync(path.join(nestedDirectory, "hidden"), "hidden 1\n");
  writeFileSync(path.join(directory, "ignored.md"), "ignored 1\n");

  assert.throws(() => listAnimations(missingDirectory), /Could not read animation directory/);
  assert.throws(() => listAnimations(directory), /No animations/);
});

test("animation parser rejects malformed numeric delays", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-title-animation-files-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const invalidValues = ["zero", "-1", "NaN", "Infinity", "1.", ".5", "1e1"];
  for (const [index, value] of invalidValues.entries()) {
    const name = `invalid-${index}`;
    writeFileSync(path.join(directory, name), `frame ${value}\n`);
    assert.throws(() => resolveAnimation(name, directory), /expected FRAME DELAY_SECONDS/);
  }
});

test("findPipePath accepts an explicit socket", () => {
  const calls = [];
  const result = findPipePath({ CODEX_APP_TOOLS_PIPE_PATH: "/tmp/explicit.sock" }, {
    statSync: (value) => {
      calls.push(value);
      return { isSocket: () => true };
    },
    commandOutput: () => assert.fail("process discovery must not run for a valid explicit socket")
  });
  assert.equal(result, "/tmp/explicit.sock");
  assert.deepEqual(calls, ["/tmp/explicit.sock"]);
});

test("findPipePath discovers one live socket and ignores unusable candidates", () => {
  const outputs = new Map([
    ["pgrep", "11\n22\n33\n44\n"],
    ["ps:11", "CODEX_APP_TOOLS_PIPE_PATH=/tmp/live.sock other=value"],
    ["ps:22", "no matching environment"],
    ["ps:33", "CODEX_APP_TOOLS_PIPE_PATH=/tmp/gone.sock"],
    ["ps:44", "CODEX_APP_TOOLS_PIPE_PATH=/tmp/live.sock"]
  ]);
  const result = findPipePath({}, {
    commandOutput: (command, argumentsValue) => command === "pgrep" ? outputs.get("pgrep") : outputs.get(`ps:${argumentsValue.at(-1)}`),
    statSync: (value) => {
      if (value === "/tmp/gone.sock") throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return { isSocket: () => value === "/tmp/live.sock" };
    }
  });
  assert.equal(result, "/tmp/live.sock");
});

test("findPipePath rejects zero or multiple discovered sockets", () => {
  assert.throws(() => findPipePath({}, { commandOutput: () => "", statSync: () => ({ isSocket: () => false }) }), /No active Codex desktop IPC pipe/);
  assert.throws(() => findPipePath({ CODEX_APP_TOOLS_PIPE_PATH: "/tmp/not-a-socket" }, {
    commandOutput: (command, argumentsValue) => command === "pgrep" ? "1\n2\n" : `CODEX_APP_TOOLS_PIPE_PATH=/tmp/${argumentsValue.at(-1)}.sock`,
    statSync: (value) => ({ isSocket: () => value !== "/tmp/not-a-socket" })
  }), /More than one Codex desktop IPC pipe.*1\.sock.*2\.sock/);
});

test("transient IPC errors are classified without treating task errors as transient", () => {
  assert.equal(isTransientIpcError(new Error("Timed out waiting for Codex desktop IPC pipe.")), true);
  assert.equal(isTransientIpcError(new Error("Codex desktop IPC pipe closed before sending a complete response.")), true);
  assert.equal(isTransientIpcError(Object.assign(new Error("connect failed"), { code: "ECONNRESET" })), true);
  assert.equal(isTransientIpcError(new Error("thread not found")), false);
});

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

test("request accepts a response split across multiple socket chunks", async (t) => {
  const socketPath = await temporarySocketServer(t, (connection) => connection.once("data", () => {
    const frame = responseFrame({ id: 1, result: { fragmented: true } });
    connection.write(frame.subarray(0, 2));
    setImmediate(() => connection.end(frame.subarray(2)));
  }));

  assert.deepEqual(await request(socketPath, "tools/list", {}), { fragmented: true });
});

test("request reports JSON-RPC errors", async (t) => {
  const socketPath = await temporarySocketServer(t, (connection) => connection.once("data", () => {
    connection.end(responseFrame({ id: 1, error: { code: 42, message: "broken" } }));
  }));

  await assert.rejects(request(socketPath, "tools/list", {}), /"code":42/);
});

test("request rejects malformed JSON responses", async (t) => {
  const socketPath = await temporarySocketServer(t, (connection) => connection.once("data", () => {
    const payload = Buffer.from("{not-json");
    const frame = Buffer.alloc(payload.length + 4);
    frame.writeUInt32LE(payload.length, 0);
    payload.copy(frame, 4);
    connection.end(frame);
  }));
  await assert.rejects(request(socketPath, "tools/list", {}), /JSON/);
});

test("request rejects an IPC connection closed before a response", async (t) => {
  const socketPath = await temporarySocketServer(t, (connection) => connection.once("data", () => connection.end()));
  await assert.rejects(request(socketPath, "tools/list", {}), /closed before sending a complete response/);
});

test("request times out when the IPC server does not respond", async (t) => {
  const socketPath = await temporarySocketServer(t, () => {});
  await assert.rejects(request(socketPath, "tools/list", {}, 20), /Timed out/);
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

test("setTitle rejects a desktop host without the title tool", async (t) => {
  const socketPath = await temporarySocketServer(t, (connection) => connection.once("data", () => {
    connection.end(responseFrame({ id: 1, result: { tools: [] } }));
  }));
  await assert.rejects(setTitle(socketPath, "thread-42", "title"), /does not expose set_thread_title/);
});

test("setTitle rejects an unconfirmed title update", async (t) => {
  let call = 0;
  const socketPath = await temporarySocketServer(t, (connection) => connection.once("data", () => {
    call += 1;
    const result = call === 1
      ? { tools: [{ name: "set_thread_title", namespace: "codex_app" }] }
      : { success: false };
    connection.end(responseFrame({ id: 1, result }));
  }));
  await assert.rejects(setTitle(socketPath, "thread-42", "title"), /did not confirm/);
});

test("readThread parses the embedded thread payload", async (t) => {
  const thread = { id: "thread-42", status: { type: "active" } };
  const socketPath = await temporarySocketServer(t, (connection) => connection.once("data", () => {
    connection.end(responseFrame({ id: 1, result: { success: true, contentItems: [{ text: JSON.stringify({ thread }) }] } }));
  }));
  assert.deepEqual(await readThread(socketPath, "thread-42"), thread);
});

test("readThread rejects unsuccessful, empty, and malformed responses", async (t) => {
  const results = [
    { success: false },
    { success: true, contentItems: [] },
    { success: true, contentItems: [{ text: "not-json" }] }
  ];
  let call = 0;
  const socketPath = await temporarySocketServer(t, (connection) => connection.once("data", () => {
    connection.end(responseFrame({ id: 1, result: results[call++] }));
  }));

  await assert.rejects(readThread(socketPath, "thread-42"), /did not confirm/);
  await assert.rejects(readThread(socketPath, "thread-42"), /no thread data/);
  await assert.rejects(readThread(socketPath, "thread-42"), /invalid thread data/);
});

test("runAnimation advances through frames", async () => {
  const titles = [];
  const delays = [];
  await assert.rejects(
    runAnimation("thread-42", "test-run", {}, {
      findPipePath: () => "unused",
      isCurrentRun: () => true,
      readThread: async () => ({ status: { type: "active" } }),
      setTitle: async (_pipe, _thread, title) => {
        titles.push(title);
      },
      steps: [
        { frame: "first", delaySeconds: 1 },
        { frame: "second", delaySeconds: 2.5 },
        { frame: "third", delaySeconds: 60 }
      ],
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        if (delays.length === 3) throw new Error("stop test loop");
      }
    }, undefined, "Running tests"),
    /stop test loop/
  );
  assert.deepEqual(titles, ["first", "second", "third"]);
  assert.deepEqual(delays, [1000, 2500, 60000]);
});

test("runAnimation renders current work into every published frame", async () => {
  const titles = [];
  await runAnimation("thread-42", "run", {}, {
    findPipePath: () => "unused",
    isCurrentRun: () => true,
    readThread: async () => ({ status: { type: titles.length === 2 ? "archived" : "active" } }),
    setTitle: async (_pipe, _thread, title) => titles.push(title),
    sleep: async () => {},
    steps: [
      { frame: "<<< {work}", delaySeconds: 1 },
      { frame: "{work} >>>", delaySeconds: 1 }
    ]
  }, "ignored", "Reviewing changes");
  assert.deepEqual(titles, ["<<< Reviewing changes", "Reviewing changes >>>"]);
});

test("runAnimation loops from the last step back to the first", async () => {
  const titles = [];
  await assert.rejects(runAnimation("thread-42", "test-run", {}, {
    findPipePath: () => "unused",
    isCurrentRun: () => true,
    readThread: async () => ({ status: { type: "active" } }),
    setTitle: async (_pipe, _thread, title) => titles.push(title),
    steps: [{ frame: "a", delaySeconds: 1 }, { frame: "b", delaySeconds: 2 }],
    sleep: async () => {
      if (titles.length === 3) throw new Error("loop complete");
    }
  }), /loop complete/);
  assert.deepEqual(titles, ["a", "b", "a"]);
});

test("runAnimation cancels the current delay immediately on SIGTERM", async (t) => {
  const environment = temporaryEnvironment();
  const runId = "signal-run";
  const stateFile = path.join(environment.CODEX_TITLE_ANIMATION_STATE_DIR, "thread-42.json");
  const signalTarget = new EventEmitter();
  let framePublished;
  const published = new Promise((resolve) => { framePublished = resolve; });
  t.after(() => rmSync(environment.CODEX_TITLE_ANIMATION_STATE_DIR, { recursive: true, force: true }));
  writeFileSync(stateFile, JSON.stringify({ runId }));

  const running = runAnimation("thread-42", runId, environment, {
    findPipePath: () => "unused",
    readThread: async () => ({ status: { type: "active" } }),
    setTitle: async () => framePublished(),
    signalTarget,
    steps: [{ frame: "waiting", delaySeconds: 60 }]
  });
  await published;
  signalTarget.emit("SIGTERM");
  await Promise.race([
    running,
    new Promise((_, reject) => setTimeout(() => reject(new Error("animation did not stop promptly")), 100))
  ]);

  assert.equal(existsSync(stateFile), false);
  assert.equal(signalTarget.listenerCount("SIGTERM"), 0);
  assert.equal(signalTarget.listenerCount("SIGINT"), 0);
});

test("runAnimation stops before reading a thread when its run id is stale", async () => {
  let readCalled = false;
  await runAnimation("thread-42", "old-run", {}, {
    findPipePath: () => "unused",
    isCurrentRun: () => false,
    readThread: async () => { readCalled = true; },
    steps: [{ frame: "a", delaySeconds: 1 }]
  });
  assert.equal(readCalled, false);
});

test("runAnimation continues across inactive turns until the thread is archived", async () => {
  const titles = [];
  const statuses = ["completed", "idle", "archived"];
  await runAnimation("thread-42", "run", {}, {
    findPipePath: () => "unused",
    isCurrentRun: () => true,
    readThread: async () => ({ status: { type: statuses.shift() } }),
    setTitle: async (_pipe, _thread, title) => { titles.push(title); },
    sleep: async () => {},
    steps: [
      { frame: "a", delaySeconds: 1 },
      { frame: "b", delaySeconds: 1 }
    ]
  });
  assert.deepEqual(titles, ["a", "b"]);
  assert.deepEqual(statuses, []);
});

test("runAnimation retries transient IPC failures and then resumes the same frame", async () => {
  const titles = [];
  const delays = [];
  let reads = 0;
  let pipeDiscoveries = 0;
  await runAnimation("thread-42", "run", {}, {
    findPipePath: () => `pipe-${++pipeDiscoveries}`,
    isCurrentRun: () => true,
    readThread: async () => {
      reads += 1;
      if (reads <= 3) throw new Error("Timed out waiting for Codex desktop IPC pipe.");
      return { status: { type: reads === 4 ? "active" : "archived" } };
    },
    setTitle: async (_pipe, _thread, title) => { titles.push(title); },
    retryDelays: [10, 20, 30],
    sleep: async (milliseconds) => { delays.push(milliseconds); },
    steps: [{ frame: "same-frame", delaySeconds: 1 }]
  });
  assert.deepEqual(titles, ["same-frame"]);
  assert.deepEqual(delays, [10, 20, 30, 1000]);
  assert.equal(pipeDiscoveries, 5);
});

test("runAnimation stops retrying after the bounded transient IPC budget", async () => {
  const delays = [];
  let reads = 0;
  await assert.rejects(runAnimation("thread-42", "run", {}, {
    findPipePath: () => "unused",
    isCurrentRun: () => true,
    readThread: async () => {
      reads += 1;
      throw new Error("Timed out waiting for Codex desktop IPC pipe.");
    },
    retryDelays: [10, 20, 30],
    sleep: async (milliseconds) => { delays.push(milliseconds); },
    steps: [{ frame: "never-published", delaySeconds: 1 }]
  }), /Timed out waiting/);
  assert.equal(reads, 4);
  assert.deepEqual(delays, [10, 20, 30]);
});

test("runAnimation cleans state when IPC discovery fails", async (t) => {
  const environment = temporaryEnvironment();
  const runId = "pipe-failure-run";
  const stateFile = path.join(environment.CODEX_TITLE_ANIMATION_STATE_DIR, "thread-42.json");
  t.after(() => rmSync(environment.CODEX_TITLE_ANIMATION_STATE_DIR, { recursive: true, force: true }));
  writeFileSync(stateFile, JSON.stringify({ runId }));

  await assert.rejects(runAnimation("thread-42", runId, environment, {
    findPipePath: () => { throw new Error("pipe missing"); }
  }), /pipe missing/);
  assert.equal(existsSync(stateFile), false);
});

test("runAnimation stops without changing an archived thread", async (t) => {
  const environment = temporaryEnvironment();
  const runId = "archive-run";
  const stateFile = path.join(environment.CODEX_TITLE_ANIMATION_STATE_DIR, "thread-42.json");
  t.after(() => rmSync(environment.CODEX_TITLE_ANIMATION_STATE_DIR, { recursive: true, force: true }));
  writeFileSync(stateFile, JSON.stringify({ runId }));
  await runAnimation("thread-42", runId, environment, {
    findPipePath: () => "unused",
    readThread: async () => ({ status: { type: "archived" } }),
    setTitle: async () => assert.fail("archived thread must not receive a title update")
  });
  assert.equal(existsSync(stateFile), false);
});

test("runAnimation cleans state when a deleted thread cannot be read", async (t) => {
  const environment = temporaryEnvironment();
  const runId = "deleted-run";
  const stateFile = path.join(environment.CODEX_TITLE_ANIMATION_STATE_DIR, "thread-42.json");
  t.after(() => rmSync(environment.CODEX_TITLE_ANIMATION_STATE_DIR, { recursive: true, force: true }));
  writeFileSync(stateFile, JSON.stringify({ runId }));
  await assert.rejects(runAnimation("thread-42", runId, environment, {
    findPipePath: () => "unused",
    readThread: async () => { throw new Error("thread not found"); }
  }), /thread not found/);
  assert.equal(existsSync(stateFile), false);
});

test("a superseded run exits without touching the replacement state or title", async (t) => {
  const environment = temporaryEnvironment();
  const stateFile = path.join(environment.CODEX_TITLE_ANIMATION_STATE_DIR, "thread-42.json");
  t.after(() => rmSync(environment.CODEX_TITLE_ANIMATION_STATE_DIR, { recursive: true, force: true }));
  writeFileSync(stateFile, JSON.stringify({ runId: "new-run", threadId: "thread-42" }));
  await runAnimation("thread-42", "old-run", environment, {
    findPipePath: () => "unused",
    readThread: async () => assert.fail("superseded run must not read the thread"),
    setTitle: async () => assert.fail("superseded run must not change the title")
  });
  assert.equal(readAnimationState(environment, "thread-42").runId, "new-run");
});

test("a run superseded while reading the thread does not publish another frame", async (t) => {
  const environment = temporaryEnvironment();
  const stateFile = path.join(environment.CODEX_TITLE_ANIMATION_STATE_DIR, "thread-42.json");
  let finishRead;
  const readStarted = new Promise((resolve) => { finishRead = resolve; });
  let releaseRead;
  const delayedThread = new Promise((resolve) => { releaseRead = resolve; });
  let titleCalled = false;
  t.after(() => rmSync(environment.CODEX_TITLE_ANIMATION_STATE_DIR, { recursive: true, force: true }));
  writeFileSync(stateFile, JSON.stringify({ runId: "old-run", threadId: "thread-42" }));

  const running = runAnimation("thread-42", "old-run", environment, {
    findPipePath: () => "unused",
    readThread: async () => {
      finishRead();
      return delayedThread;
    },
    setTitle: async () => { titleCalled = true; },
    steps: [{ frame: "stale", delaySeconds: 1 }]
  });
  await readStarted;
  writeFileSync(stateFile, JSON.stringify({ runId: "new-run", threadId: "thread-42" }));
  releaseRead({ status: { type: "active" } });
  await running;

  assert.equal(titleCalled, false);
  assert.equal(readAnimationState(environment, "thread-42").runId, "new-run");
});

test("runAnimation removes state when its animation cannot be loaded", async (t) => {
  const environment = temporaryEnvironment();
  const runId = "missing-animation-run";
  const stateFile = path.join(environment.CODEX_TITLE_ANIMATION_STATE_DIR, "thread-42.json");
  t.after(() => rmSync(environment.CODEX_TITLE_ANIMATION_STATE_DIR, { recursive: true, force: true }));
  writeFileSync(stateFile, JSON.stringify({ runId }));

  await assert.rejects(runAnimation("thread-42", runId, environment, {
    findPipePath: () => "unused",
    resolveAnimation: () => { throw new Error("animation disappeared"); }
  }, "missing"), /animation disappeared/);
  assert.equal(existsSync(stateFile), false);
});

test("start prepares the current process as a foreground animation session", (t) => {
  const environment = temporaryEnvironment();
  const animationDirectory = mkdtempSync(path.join(os.tmpdir(), "codex-title-animation-files-"));
  const manager = fakeSessionManager();
  const dependencies = { ...manager.dependencies, animationDirectory };
  delete dependencies.resolveAnimation;
  t.after(() => rmSync(environment.CODEX_TITLE_ANIMATION_STATE_DIR, { recursive: true, force: true }));
  t.after(() => rmSync(animationDirectory, { recursive: true, force: true }));
  writeFileSync(path.join(animationDirectory, "b"), "b 1\n");
  writeFileSync(path.join(animationDirectory, "a"), "a 1\n");

  const result = startAnimation("thread-a", environment, dependencies, undefined, "Running tests");
  const state = readAnimationState(environment, "thread-a");
  assert.equal(result.pid, state.pid);
  assert.equal(result.runId, state.runId);
  assert.equal(result.animationName, "a");
  assert.equal(state.animationName, "a");
  assert.equal(result.currentWork, "Running tests");
  assert.equal(state.currentWork, "Running tests");
  assert.equal(state.processTitle, `codex-title-animation:thread-a:${state.runId}`);
  assert.equal(manager.running.get(state.pid), state.processTitle);
});

test("start and stop reject an empty thread id", () => {
  assert.throws(() => startAnimation(""), /start THREAD_ID/);
  assert.throws(() => stopAnimation(""), /stop THREAD_ID/);
});

test("different threads run independently at the same time", (t) => {
  const environment = temporaryEnvironment();
  const manager = fakeSessionManager();
  t.after(() => rmSync(environment.CODEX_TITLE_ANIMATION_STATE_DIR, { recursive: true, force: true }));

  const first = startAnimation("thread-a", environment, manager.dependencies, "ping-pong");
  const second = startAnimation("thread-b", environment, manager.dependencies, "spinner");

  assert.notEqual(first.pid, second.pid);
  assert.equal(manager.killed.length, 0);
  assert.equal(readAnimationState(environment, "thread-a").pid, first.pid);
  assert.equal(readAnimationState(environment, "thread-a").animationName, "ping-pong");
  assert.equal(readAnimationState(environment, "thread-b").pid, second.pid);
  assert.equal(readAnimationState(environment, "thread-b").animationName, "spinner");
  assert.equal(manager.running.size, 2);
});

test("restarting one thread replaces only that thread animation", (t) => {
  const environment = temporaryEnvironment();
  const manager = fakeSessionManager();
  t.after(() => rmSync(environment.CODEX_TITLE_ANIMATION_STATE_DIR, { recursive: true, force: true }));

  const firstA = startAnimation("thread-a", environment, manager.dependencies, "ping-pong");
  const firstB = startAnimation("thread-b", environment, manager.dependencies, "spinner");
  const stateBeforeRestartB = readAnimationState(environment, "thread-b");
  const secondA = startAnimation("thread-a", environment, manager.dependencies, "next-animation");

  assert.deepEqual(manager.killed, [{ pid: firstA.pid, signal: "SIGTERM" }]);
  assert.notEqual(secondA.pid, firstA.pid);
  assert.equal(readAnimationState(environment, "thread-a").pid, secondA.pid);
  assert.equal(readAnimationState(environment, "thread-a").animationName, "next-animation");
  assert.deepEqual(readAnimationState(environment, "thread-b"), stateBeforeRestartB);
  assert.equal(manager.running.has(firstB.pid), true);
});

test("stopping one thread does not stop another thread animation", (t) => {
  const environment = temporaryEnvironment();
  const manager = fakeSessionManager();
  t.after(() => rmSync(environment.CODEX_TITLE_ANIMATION_STATE_DIR, { recursive: true, force: true }));

  const firstA = startAnimation("thread-a", environment, manager.dependencies);
  const firstB = startAnimation("thread-b", environment, manager.dependencies);
  const stateBeforeStopB = readAnimationState(environment, "thread-b");

  assert.deepEqual(stopAnimation("thread-a", environment, manager.dependencies), { stopped: true, pid: firstA.pid });
  assert.deepEqual(manager.killed, [{ pid: firstA.pid, signal: "SIGTERM" }]);
  assert.equal(manager.running.has(firstA.pid), false);
  assert.equal(manager.running.has(firstB.pid), true);
  assert.deepEqual(readAnimationState(environment, "thread-b"), stateBeforeStopB);
});

test("a stale state starts a replacement without signaling an unrelated PID", (t) => {
  const environment = temporaryEnvironment();
  const manager = fakeSessionManager();
  const stateFile = path.join(environment.CODEX_TITLE_ANIMATION_STATE_DIR, "thread-a.json");
  t.after(() => rmSync(environment.CODEX_TITLE_ANIMATION_STATE_DIR, { recursive: true, force: true }));
  writeFileSync(stateFile, JSON.stringify({
    pid: 9999,
    runId: "stale-run",
    threadId: "thread-a",
    scriptPath: "/tmp/codex-title-animation.mjs",
    processTitle: "codex-title-animation:thread-a:stale-run",
    animationName: "ping-pong"
  }));

  const replacement = startAnimation("thread-a", environment, manager.dependencies, "spinner");

  assert.equal(manager.killed.length, 0);
  assert.equal(readAnimationState(environment, "thread-a").pid, replacement.pid);
  assert.equal(readAnimationState(environment, "thread-a").animationName, "spinner");
});

test("invalid animation input does not replace a running animation", (t) => {
  const environment = temporaryEnvironment();
  const manager = fakeSessionManager();
  const dependencies = {
    ...manager.dependencies,
    resolveAnimation: (name) => {
      if (name === "missing") throw new Error("Animation was not found: missing");
      return { name: name || "ping-pong", steps: [{ frame: "frame", delaySeconds: 1 }] };
    }
  };
  t.after(() => rmSync(environment.CODEX_TITLE_ANIMATION_STATE_DIR, { recursive: true, force: true }));
  const active = startAnimation("thread-a", environment, dependencies, "ping-pong");
  const stateBeforeFailure = readAnimationState(environment, "thread-a");

  assert.throws(() => startAnimation("thread-a", environment, dependencies, "missing"), /not found/);
  assert.equal(manager.killed.length, 0);
  assert.equal(manager.running.has(active.pid), true);
  assert.deepEqual(readAnimationState(environment, "thread-a"), stateBeforeFailure);
});

test("a restart restores the previous state when signaling it fails", (t) => {
  const environment = temporaryEnvironment();
  const manager = fakeSessionManager();
  t.after(() => rmSync(environment.CODEX_TITLE_ANIMATION_STATE_DIR, { recursive: true, force: true }));
  const first = startAnimation("thread-a", environment, manager.dependencies, "first");
  const previousState = readAnimationState(environment, "thread-a");
  const signalError = Object.assign(new Error("signal denied"), { code: "EPERM" });

  assert.throws(() => startAnimation("thread-a", environment, { ...manager.dependencies, kill: () => { throw signalError; } }, "second"), /signal denied/);
  assert.deepEqual(readAnimationState(environment, "thread-a"), previousState);
  assert.equal(manager.running.has(first.pid), true);
});

test("a restart continues when the previous process disappears before SIGTERM", (t) => {
  const environment = temporaryEnvironment();
  const manager = fakeSessionManager();
  t.after(() => rmSync(environment.CODEX_TITLE_ANIMATION_STATE_DIR, { recursive: true, force: true }));
  const first = startAnimation("thread-a", environment, manager.dependencies, "first");
  const dependencies = {
    ...manager.dependencies,
    kill: (pid) => {
      manager.running.delete(pid);
      throw Object.assign(new Error("already gone"), { code: "ESRCH" });
    }
  };

  const replacement = startAnimation("thread-a", environment, dependencies, "second");
  assert.notEqual(replacement.pid, first.pid);
  assert.equal(readAnimationState(environment, "thread-a").pid, replacement.pid);
  assert.equal(readAnimationState(environment, "thread-a").animationName, "second");
});

test("start and stop report a corrupt state file without overwriting it", (t) => {
  const environment = temporaryEnvironment();
  const stateFile = path.join(environment.CODEX_TITLE_ANIMATION_STATE_DIR, "thread-a.json");
  t.after(() => rmSync(environment.CODEX_TITLE_ANIMATION_STATE_DIR, { recursive: true, force: true }));
  writeFileSync(stateFile, "not-json\n");

  assert.throws(() => startAnimation("thread-a", environment, fakeSessionManager().dependencies), /Could not read animation state/);
  assert.throws(() => stopAnimation("thread-a", environment), /Could not read animation state/);
  assert.equal(readFileSync(stateFile, "utf8"), "not-json\n");
});

test("stop requests SIGTERM only for the tracked animation", (t) => {
  const environment = temporaryEnvironment();
  const manager = fakeSessionManager();
  t.after(() => rmSync(environment.CODEX_TITLE_ANIMATION_STATE_DIR, { recursive: true, force: true }));
  const started = startAnimation("thread-42", environment, manager.dependencies);
  let signal;
  assert.deepEqual(stopAnimation("thread-42", environment, { ...manager.dependencies, kill: (_pid, requestedSignal) => { signal = requestedSignal; } }), { stopped: true, pid: started.pid });
  assert.equal(signal, "SIGTERM");
});

test("stop ignores a state file whose PID belongs to another process", (t) => {
  const environment = temporaryEnvironment();
  const manager = fakeSessionManager();
  t.after(() => rmSync(environment.CODEX_TITLE_ANIMATION_STATE_DIR, { recursive: true, force: true }));
  startAnimation("thread-42", environment, manager.dependencies);
  let killCalled = false;
  const result = stopAnimation("thread-42", environment, {
    processCommand: () => "/tmp/unrelated-process",
    kill: () => { killCalled = true; }
  });
  assert.deepEqual(result, { stopped: false, pid: null });
  assert.equal(killCalled, false);
});

test("stop is safe when no state exists", (t) => {
  const environment = temporaryEnvironment();
  t.after(() => rmSync(environment.CODEX_TITLE_ANIMATION_STATE_DIR, { recursive: true, force: true }));
  assert.deepEqual(stopAnimation("thread-42", environment), { stopped: false, pid: null });
});

test("stop removes stale state without signaling a process", (t) => {
  const environment = temporaryEnvironment();
  const stateFile = path.join(environment.CODEX_TITLE_ANIMATION_STATE_DIR, "thread-42.json");
  let killCalled = false;
  t.after(() => rmSync(environment.CODEX_TITLE_ANIMATION_STATE_DIR, { recursive: true, force: true }));
  writeFileSync(stateFile, JSON.stringify({ pid: 9999, runId: "stale", scriptPath: "/tmp/script.mjs" }));

  assert.deepEqual(stopAnimation("thread-42", environment, {
    isRunning: () => false,
    kill: () => { killCalled = true; }
  }), { stopped: false, pid: null });
  assert.equal(killCalled, false);
  assert.equal(existsSync(stateFile), false);
});

test("stop treats ESRCH as an already-stopped animation and removes state", (t) => {
  const environment = temporaryEnvironment();
  const manager = fakeSessionManager();
  t.after(() => rmSync(environment.CODEX_TITLE_ANIMATION_STATE_DIR, { recursive: true, force: true }));
  const started = startAnimation("thread-a", environment, manager.dependencies);

  const result = stopAnimation("thread-a", environment, {
    ...manager.dependencies,
    kill: () => { throw Object.assign(new Error("already gone"), { code: "ESRCH" }); }
  });
  assert.deepEqual(result, { stopped: true, pid: started.pid });
  assert.equal(existsSync(path.join(environment.CODEX_TITLE_ANIMATION_STATE_DIR, "thread-a.json")), false);
});

test("main routes start, stop, and run arguments", async () => {
  const calls = [];
  const messages = [];
  const dependencies = {
    startAnimation: (...argumentsValue) => {
      calls.push(["start", ...argumentsValue]);
      const threadId = argumentsValue[0];
      const animationName = argumentsValue[3] || "ping-pong";
      const currentWork = argumentsValue[4] || "";
      return { started: true, pid: 51, runId: `run-${threadId}`, animationName, currentWork };
    },
    stopAnimation: (...argumentsValue) => { calls.push(["stop", ...argumentsValue]); return { stopped: true, pid: 52 }; },
    runAnimation: async (...argumentsValue) => { calls.push(["run", ...argumentsValue]); },
    animationDependencies: { marker: true },
    log: (message) => messages.push(message)
  };
  const environment = { TEST: "yes" };

  await main(["start", "thread-a", "Running tests", "spinner"], environment, dependencies);
  await main(["start", "thread-b", "Reviewing changes"], environment, dependencies);
  await main(["start", "thread-c", "", "wizard"], environment, dependencies);
  await main(["start", "thread-d"], environment, dependencies);
  await main(["start", "thread-e", "wizard"], environment, dependencies);
  await main(["stop", "thread-a"], environment, dependencies);
  await main(["run", "thread-a", "spinner", "run-1", "Checking output"], environment, dependencies);

  assert.deepEqual(calls, [
    ["start", "thread-a", environment, dependencies.animationDependencies, "spinner", "Running tests"],
    ["run", "thread-a", "run-thread-a", environment, dependencies.animationDependencies, "spinner", "Running tests"],
    ["start", "thread-b", environment, dependencies.animationDependencies, undefined, "Reviewing changes"],
    ["run", "thread-b", "run-thread-b", environment, dependencies.animationDependencies, "ping-pong", "Reviewing changes"],
    ["start", "thread-c", environment, dependencies.animationDependencies, "wizard", ""],
    ["run", "thread-c", "run-thread-c", environment, dependencies.animationDependencies, "wizard", ""],
    ["start", "thread-d", environment, dependencies.animationDependencies, undefined, ""],
    ["run", "thread-d", "run-thread-d", environment, dependencies.animationDependencies, "ping-pong", ""],
    ["start", "thread-e", environment, dependencies.animationDependencies, undefined, "wizard"],
    ["run", "thread-e", "run-thread-e", environment, dependencies.animationDependencies, "ping-pong", "wizard"],
    ["stop", "thread-a", environment, dependencies.animationDependencies],
    ["run", "thread-a", "run-1", environment, dependencies.animationDependencies, "spinner", "Checking output"]
  ]);
  assert.deepEqual(messages, [
    "Animation session started (PID 51). Keep this terminal session running.",
    "Animation session started (PID 51). Keep this terminal session running.",
    "Animation session started (PID 51). Keep this terminal session running.",
    "Animation session started (PID 51). Keep this terminal session running.",
    "Animation session started (PID 51). Keep this terminal session running.",
    "Animation stop requested (PID 52)."
  ]);
});

test("main reports when stop finds no tracked animation", async () => {
  const messages = [];
  await main(["stop", "thread-a"], {}, {
    stopAnimation: () => ({ stopped: false, pid: null }),
    log: (message) => messages.push(message)
  });
  assert.deepEqual(messages, ["No tracked animation is running."]);
});

test("main rejects unsupported and incomplete actions", async () => {
  await assert.rejects(main(["unknown", "thread-42"], {}), /Usage:/);
  await assert.rejects(main(["start", "thread-42", "Testing", "spinner", "extra"], {}), /CURRENT_WORK/);
  await assert.rejects(main(["stop", "thread-42", "extra"], {}), /stop THREAD_ID/);
  await assert.rejects(main(["run", "thread-42"], {}), /Usage:/);
  await assert.rejects(main(["run", "thread-42", "spinner", "run-1", "work", "extra"], {}), /run THREAD_ID/);
});

test("the executable entrypoint prints usage errors and exits non-zero", () => {
  const result = spawnSync(process.execPath, [scriptPath.pathname, "unknown", "thread-42"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Title animation failed: Usage:/);
});
