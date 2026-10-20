import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough, Readable } from "node:stream";
import { EventEmitter, once } from "node:events";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { spawnDsh, killTree } from "../scripts/lib/dsh.mjs";
import { posixProcessIdentity, OWNER_ENV } from "../scripts/lib/posix-process.mjs";
import { isAlive } from "../scripts/lib/jobs.mjs";
import { randomUUID } from "node:crypto";
import path from "node:path";

// child_process 与 stdio 是操作系统边界；不替换 runDsh 或作业管理实现。
async function hostBoundary(t) {
  const host = await import("../scripts/deepseek-dsh-host.mjs");
  assert.equal(typeof host.runDshHost, "function", "宿主必须允许验证完整的管道生命周期");
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const calls = [];
  t.mock.method(childProcess, "spawn", (...args) => { calls.push(args); return child; });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const output = new PassThrough();
  const error = new PassThrough();
  return { ...host, child, calls, output, error };
}

test("宿主收到任务正文前不启动 dsh，worker 提前退出不会遗留未登记的 dsh", async (t) => {
  const { runDshHost, calls, output, error } = await hostBoundary(t);
  assert.equal(await runDshHost("fake-dsh.exe", [], { input: Readable.from([]), output, error }), 1);
  assert.equal(calls.length, 0);
});

test("worker 输出管道断开后宿主继续持有 dsh，stdin 与最终退出码仍正确", async (t) => {
  const { runDshHost, child, calls, output, error } = await hostBoundary(t);
  let input = "";
  child.stdin.on("data", (chunk) => { input += chunk; });
  let settled = false;
  const pending = runDshHost("fake-dsh.exe", ["--json", "-"], {
    input: Readable.from([Buffer.from("任务正文")]), output, error,
  }).then((code) => { settled = true; return code; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].cwd, process.cwd());
  assert.equal(input, "任务正文");
  assert.equal(settled, false);
  output.destroy(Object.assign(new Error("worker exited"), { code: "EPIPE" }));
  error.destroy(Object.assign(new Error("worker exited"), { code: "EPIPE" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.doesNotThrow(() => child.stdout.write("后续进度\n"));
  assert.doesNotThrow(() => child.stderr.write("后续诊断\n"));
  assert.equal(settled, false, "worker 的管道关闭不能使宿主提前退出");
  child.emit("close", 3);
  assert.equal(await pending, 3);
});

test("dsh exit 时先清理继承输出管道的后代，再等待 close 排空最终输出", async (t) => {
  const { runDshHost, child, output, error } = await hostBoundary(t);
  let cleaned = false;
  let text = "";
  output.on("data", (chunk) => { text += chunk; });
  const pending = runDshHost("fake-dsh.exe", [], {
    input: Readable.from(["任务"]), output, error,
    onExited: async () => { cleaned = true; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  child.emit("exit", 3);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleaned, true, "不能等被后代持有的管道 close 后才开始清理");
  child.stdout.write("仍在管道中的最终输出");
  child.emit("close", 3);
  assert.equal(await pending, 3);
  assert.equal(text, "仍在管道中的最终输出", "清理后仍须排空输出，不能在 exit 时直接结束宿主");
});

test("真实 dsh 先退出时终止分离后代并保留完整输出和宿主恢复入口", { timeout: 25000 }, async () => {
  const token = randomUUID();
  const payload = "x".repeat(256 * 1024);
  const code = `
    const { spawn } = require('node:child_process');
    process.stdin.resume();
    process.stdin.on('end', () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        detached: process.platform === 'win32',
        stdio: process.platform === 'win32' ? 'ignore' : ['ignore', 1, 2],
        env: process.platform === 'win32' ? process.env : {}
      });
      child.unref();
      process.stdout.write(JSON.stringify({ pid: child.pid })+'\\n');
      process.stdout.write('x'.repeat(256*1024), () => { process.exitCode = 3; });
    });`;
  const child = spawnDsh(process.execPath, ["-e", code], {
    env: { ...process.env, [OWNER_ENV]: token }, stdio: ["pipe", "pipe", "pipe"], cwd: process.cwd(),
  }, token);
  const exited = once(child, "exit");
  const drained = Promise.all([exited, once(child.stdout, "end"), once(child.stderr, "end")]);
  const timer = new AbortController();
  let stdout = "";
  let descendant;
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (stdout.includes("\n")) descendant = JSON.parse(stdout.slice(0, stdout.indexOf("\n"))).pid;
  });
  child.stderr.resume();
  const first = Promise.race([
    once(child, "message").then(([message]) => ({ kind: "message", message })),
    exited.then(() => ({ kind: "exit" })),
    delay(18000, null, { signal: timer.signal }).then(() => ({ kind: "timeout" }), () => ({ kind: "aborted" })),
  ]);
  try {
    await once(child, "spawn");
    const identity = process.platform === "win32" ? child.deepseekIdentity : posixProcessIdentity(child.pid, token);
    child.deepseekIdentity = identity;
    child.stdin.end("测试正文");
    const event = await first;
    assert.equal(event.kind, "message", "dsh 退出不代表整个树退出，宿主必须先完成后代清理");
    assert.deepEqual(event.message, { type: "deepseek-dsh-exit", exitCode: 3 });
    assert.equal(isAlive(descendant), false, "独立或清空环境的后代必须已被清理");
    child.disconnect();
    await delay(50);
    assert.equal(child.exitCode, null, "worker 断开后仍应持有可核实的树根，供 status/cancel 清理");
    killTree({ pid: child.pid, identity });
    // 此处主动断开 IPC 模拟 worker 崩溃；分别确认进程退出和两个输出 EOF。
    await drained;
    assert.equal(stdout.slice(stdout.indexOf("\n") + 1), payload, "最终输出不能被提前终止截断");
  } finally {
    timer.abort();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    if (descendant) { try { process.kill(descendant, "SIGKILL"); } catch (err) { if (err.code !== "ESRCH") throw err; } }
  }
});

test("真实 IPC 宿主在 dsh 退出和 worker 断开后仍保留可定位的组根（Windows 无 pwsh 时使用系统 PowerShell）", async () => {
  const script = fileURLToPath(new URL("../scripts/deepseek-dsh-host.mjs", import.meta.url));
  const token = randomUUID();
  const child = childProcess.fork(script, [`--deepseek-owner=${token}`, process.execPath, "-e", "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('done'))"], {
    stdio: ["pipe", "pipe", "pipe", "ipc"], detached: true, windowsHide: true,
    env: { ...process.env, [OWNER_ENV]: token, ...(process.platform === "win32" ? {
      PATH: [path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0"), path.join(process.env.SystemRoot, "System32")].join(path.delimiter),
    } : {}) },
  });
  const exited = once(child, "exit");
  const first = Promise.race([
    once(child, "message").then(([message]) => ({ kind: "message", message })),
    exited.then(() => ({ kind: "exit" })),
  ]);
  child.stdout.resume(); child.stderr.resume();
  child.stdin.end("测试正文");
  try {
    const event = await first;
    assert.equal(event.kind, "message", "真实 dsh 结束后宿主不能先退出并遗留无环境标识的后代");
    assert.deepEqual(event.message, { type: "deepseek-dsh-exit", exitCode: 0 });
    child.disconnect();
    await delay(50);
    assert.equal(child.exitCode, null, "IPC 断开代表 worker 退出，宿主仍应等待恢复清理");
    assert.equal(process.kill(child.pid, 0), true);
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
});
