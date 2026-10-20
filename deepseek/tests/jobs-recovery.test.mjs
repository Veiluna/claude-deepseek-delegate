import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { tmpDir } from "./helpers.mjs";
import { workspaceDir } from "../scripts/lib/state.mjs";
import { saveJob, readJob, jobStatus, cancelJob, startJob, withJobsLock } from "../scripts/lib/jobs.mjs";
import { runDsh } from "../scripts/lib/dsh.mjs";
import { windowsProcessInstance } from "../scripts/lib/windows-process.mjs";
import { cleanPosixDescendants, posixProcessIdentity } from "../scripts/lib/posix-process.mjs";

const token = "11111111-1111-4111-8111-111111111111";
const windowsReply = (options, result) => options.env.DEEPSEEK_TREE_ACTION === "birthtime" ? { status: 0, stdout: "1000" } : result;
function fixture(t, platform) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const previous = { ...process.env };
  const root = tmpDir("ds-recovery-");
  Object.defineProperty(process, "platform", { value: platform });
  process.env.CLAUDE_PLUGIN_DATA = path.join(root, "data");
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(root);
  t.after(() => {
    t.mock.restoreAll(); syncBuiltinESMExports();
    Object.defineProperty(process, "platform", descriptor);
    for (const name of ["CLAUDE_PLUGIN_DATA", "GIT_CEILING_DIRECTORIES"]) {
      if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const dir = path.join(workspaceDir(root), "jobs");
  const job = { id: token, kind: "task", status: "running", pid: 40001, dshPid: 40002,
    createdAt: "2020-01-01T00:00:00.000Z", startedAt: "2020-01-01T00:00:01.000Z",
    finishedAt: null, logPath: path.join(dir, `${token}.log`) };
  fs.writeFileSync(job.logPath, "running\n");
  return { root, dir, job };
}

test("Windows 宿主 PID 被复用后 status 安全跳过并持久化失败终态", async (t) => {
  const { root, job } = fixture(t, "win32");
  job.workerIdentity = { script: "worker.mjs", token };
  job.dshIdentity = { script: "host.mjs", token };
  const actions = [];
  t.mock.method(childProcess, "spawnSync", (_command, _args, options) => {
    actions.push([options.env.DEEPSEEK_TREE_PID, options.env.DEEPSEEK_TREE_ACTION]);
    return windowsReply(options, { status: options.env.DEEPSEEK_TREE_PID === String(job.pid) ? 3 : 2 });
  });
  syncBuiltinESMExports();
  await saveJob(root, job);
  assert.equal((await jobStatus(root, job.id)).status, "failed");
  assert.equal(readJob(root, job.id).status, "failed");
  assert.ok(readJob(root, job.id).finishedAt);
  assert.ok(actions.some(([pid]) => pid === String(job.dshPid)));
});

test("Windows 宿主身份查询失败仍报告明确错误并保留待恢复状态", async (t) => {
  const { root, job } = fixture(t, "win32");
  job.workerIdentity = { script: "worker.mjs", token };
  job.dshIdentity = { script: "host.mjs", token };
  t.mock.method(childProcess, "spawnSync", (_command, _args, options) => windowsReply(options, {
    status: options.env.DEEPSEEK_TREE_PID === String(job.pid) ? 3 : 1,
  }));
  syncBuiltinESMExports();
  await saveJob(root, job);
  await assert.rejects(jobStatus(root, job.id), /无法核实/);
  assert.equal(readJob(root, job.id).status, "running");
});

function linuxBoundary(t, processes, { denied = false, onSignal } = {}) {
  processes[process.pid] ??= { startTime: "80", pgid: 50000 };
  const read = fs.readFileSync;
  const list = fs.readdirSync;
  const signals = [];
  const missing = () => Object.assign(new Error("不存在"), { code: "ENOENT" });
  t.mock.method(fs, "readFileSync", (target, ...args) => {
    const file = String(target);
    if (file === "/proc/sys/kernel/random/boot_id") return "boot-A\n";
    const match = /^\/proc\/(\d+)\/(stat|environ)$/.exec(file);
    if (!match) return read.call(fs, target, ...args);
    if (denied) throw Object.assign(new Error("private data"), { code: "EACCES" });
    const p = processes[match[1]];
    if (!p) throw missing();
    if (match[2] === "environ") return Buffer.from(p.token === null ? "PATH=/usr/bin\0" : `DEEPSEEK_JOB_OWNER=${p.token || "other-job"}\0`);
    // 固定 /proc stat 夹具：含空格和右括号的 comm，starttime 是字段 22。
    return `${match[1]} (fake process) with parens) S 1 ${p.pgid} ${p.session ?? p.pgid} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${p.startTime}\n`;
  });
  t.mock.method(fs, "readdirSync", (target, ...args) => String(target) === "/proc" ? Object.keys(processes) : list.call(fs, target, ...args));
  t.mock.method(process, "kill", (pid, signal) => {
    if (signal === 0) {
      if (pid === process.pid || processes[pid]) return true;
      throw Object.assign(new Error("不存在"), { code: "ESRCH" });
    }
    signals.push([pid, signal]);
    if (pid < 0 && !Object.values(processes).some((p) => p.pgid === -pid)) throw Object.assign(new Error("进程组不存在"), { code: "ESRCH" });
    onSignal?.(pid, signal);
    return true;
  });
  return signals;
}
function posixIdentities(job) {
  job.workerIdentity = { platform: "linux", startTime: "100", pgid: job.pid, session: job.pid, bootId: "boot-A", token };
  job.dshIdentity = { ...job.workerIdentity, startTime: "110" };
}

test("POSIX 崩溃恢复不向已复用的 dsh PID 或无关进程组发送信号", async (t) => {
  const { root, job } = fixture(t, "linux");
  posixIdentities(job);
  const signals = linuxBoundary(t, { [job.dshPid]: { startTime: "200", pgid: job.dshPid } });
  await saveJob(root, job);
  assert.equal((await jobStatus(root, job.id)).status, "failed");
  assert.deepEqual(signals, [], "旧进程组不存在时不能退回正 PID SIGKILL");
});

test("POSIX 旧进程组编号被无关进程复用时不发送信号", async (t) => {
  const { root, job } = fixture(t, "linux");
  posixIdentities(job);
  const signals = linuxBoundary(t, { [job.pid]: { startTime: "900", pgid: job.pid } });
  await saveJob(root, job);
  assert.equal((await jobStatus(root, job.id)).status, "failed");
  assert.deepEqual(signals, []);
});

test("POSIX 无作业标识的普通进程复用组长 PID 后仍能安全恢复失败终态", async (t) => {
  const { root, job } = fixture(t, "linux");
  posixIdentities(job);
  const signals = linuxBoundary(t, { [job.pid]: { startTime: "900", pgid: job.pid, token: null } });
  await saveJob(root, job);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await jobStatus(root, job.id)).status, "failed");
    assert.equal(readJob(root, job.id).status, "failed");
  }
  assert.deepEqual(signals, [], "已确认组长实例被复用，不能因缺少环境标识而阻断终态或误杀");
});

test("POSIX 归属查询失败时保留明确错误且不发送信号", async (t) => {
  const { root, job } = fixture(t, "linux");
  posixIdentities(job);
  const signals = linuxBoundary(t, {}, { denied: true });
  await saveJob(root, job);
  await assert.rejects(jobStatus(root, job.id), /无法核实/);
  assert.deepEqual(signals, []);
  assert.equal(readJob(root, job.id).status, "running");
});

test("POSIX worker 和 dsh 已退出仍能核对并终止属于作业的孤儿进程组", async (t) => {
  const { root, job } = fixture(t, "linux");
  posixIdentities(job);
  const signals = linuxBoundary(t, { 40003: { startTime: "120", pgid: job.pid, token } });
  await saveJob(root, job);
  assert.equal((await jobStatus(root, job.id)).status, "failed");
  assert.ok(signals.length > 0);
  assert.ok(signals.every(([pid, signal]) => pid === -job.pid && signal === "SIGKILL"));
});

test("POSIX cancel 核对实例、会话和作业标识后只终止所属进程组", async (t) => {
  const { root, job } = fixture(t, "linux");
  posixIdentities(job);
  const signals = linuxBoundary(t, {
    [job.pid]: { startTime: "100", pgid: job.pid, token },
    [job.dshPid]: { startTime: "110", pgid: job.pid, token },
    40003: { startTime: "120", pgid: job.pid, token },
  });
  await saveJob(root, job);
  assert.equal((await cancelJob(root, job.id)).status, "cancelled");
  assert.ok(signals.length > 0);
  assert.ok(signals.every(([pid, signal]) => pid === -job.pid && signal === "SIGKILL"));
});

test("POSIX 组内混入身份不符的进程时拒绝取消，不能误杀无关进程", async (t) => {
  const { root, job } = fixture(t, "linux");
  posixIdentities(job);
  const signals = linuxBoundary(t, {
    [job.pid]: { startTime: "100", pgid: job.pid, token },
    40003: { startTime: "120", pgid: job.pid },
  });
  await saveJob(root, job);
  await assert.rejects(cancelJob(root, job.id), /无法核实/);
  assert.deepEqual(signals, []);
  assert.equal(readJob(root, job.id).status, "running");
  assert.ok(readJob(root, job.id).cancelRequestedAt);
});

test("POSIX 已核实作业进程组内清空环境的合法后代仍能被取消", async (t) => {
  const { root, job } = fixture(t, "linux");
  posixIdentities(job);
  const signals = linuxBoundary(t, {
    [job.pid]: { startTime: "100", pgid: job.pid, token },
    [job.dshPid]: { startTime: "110", pgid: job.pid, token },
    40003: { startTime: "120", pgid: job.pid, token: null },
  });
  await saveJob(root, job);
  assert.equal((await cancelJob(root, job.id)).status, "cancelled");
  assert.ok(signals.length > 0);
  assert.ok(signals.every(([pid, signal]) => pid === -job.pid && signal === "SIGKILL"));
});

test("POSIX 宿主排空管道前清理 env-i 后代，但保留自身作为进程组归属入口", async (t) => {
  fixture(t, "linux");
  const processes = {
    [process.pid]: { startTime: "80", pgid: process.pid, token },
    40019: { startTime: "90", pgid: process.pid, token: null },
  };
  const signals = linuxBoundary(t, processes, { onSignal: (pid, signal) => { if (signal === "SIGKILL") delete processes[pid]; } });
  await cleanPosixDescendants(posixProcessIdentity(process.pid, token));
  assert.deepEqual(signals, [[40019, "SIGKILL"]]);
  assert.ok(processes[process.pid], "宿主必须存活到输出排空和 worker 确认清理");
});

test("POSIX 排空管道的清理在发送信号前再次核对后代实例，PID 复用时拒绝误杀", async (t) => {
  fixture(t, "linux");
  const processes = {
    [process.pid]: { startTime: "80", pgid: process.pid, token },
    40019: { startTime: "90", pgid: process.pid, token: null },
  };
  const signals = linuxBoundary(t, processes);
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (target, ...args) => {
    const result = read.call(fs, target, ...args);
    if (String(target) === "/proc/40019/environ") processes[40019].startTime = "200";
    return result;
  });
  await assert.rejects(cleanPosixDescendants(posixProcessIdentity(process.pid, token)), /无法核实/);
  assert.deepEqual(signals, []);
});

test("崩溃锁持有者 PID 被复用后核对创建时间并回收旧代际", async (t) => {
  const { root, dir, job } = fixture(t, "linux");
  linuxBoundary(t, {
    [process.pid]: { startTime: "80", pgid: 50000 },
    [job.pid]: { startTime: "200", pgid: job.pid },
  });
  const lock = path.join(dir, ".lock");
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, `${job.pid}-dead-instance`), JSON.stringify({ platform: "linux", startTime: "100", bootId: "boot-A" }));
  // 让旧实现的 15 秒锁超时可在两次轮询内复现；不改变生产超时或现有测试。
  let now = Date.now();
  t.mock.method(Date, "now", () => (now += 3000));
  let entered = 0;
  await withJobsLock(root, async () => { entered++; });
  assert.equal(entered, 1);
  assert.equal(fs.existsSync(lock), false);
  assert.deepEqual(fs.readdirSync(dir), [`${token}.log`]);
});

test("Windows 原生创建时间不符的锁可回收，当前占用该 PID 的进程不受影响", { skip: process.platform !== "win32" }, async (t) => {
  const { root, dir } = fixture(t, "win32");
  const child = childProcess.spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    cwd: root, windowsHide: true, stdio: "ignore",
  });
  const exited = once(child, "exit");
  await once(child, "spawn");
  try {
    const instance = windowsProcessInstance(child.pid);
    assert.match(instance.startTime, /^\d+$/);
    const lock = path.join(dir, ".lock");
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, `${child.pid}-stale-instance`), JSON.stringify({ ...instance, startTime: "0" }));
    let entered = false;
    await withJobsLock(root, async () => { entered = true; });
    assert.equal(entered, true);
    assert.equal(process.kill(child.pid, 0), true, "回收旧锁不能终止复用 PID 的无关进程");
    assert.equal(fs.existsSync(lock), false);
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
});

test("Windows 旧宿主 PID 复用不阻断第 51 个作业的创建及记录日志淘汰", async (t) => {
  const { root, dir, job } = fixture(t, "win32");
  job.workerIdentity = { script: "worker.mjs", token };
  job.dshIdentity = { script: "host.mjs", token };
  await saveJob(root, job);
  for (let i = 1; i < 50; i++) {
    const id = `old-${i}`;
    const logPath = path.join(dir, `${id}.log`);
    fs.writeFileSync(logPath, "已有日志");
    await saveJob(root, { ...job, id, status: "completed", createdAt: `2021-01-01T00:00:${String(i).padStart(2, "0")}.000Z`, logPath });
  }
  t.mock.method(childProcess, "spawnSync", (_cmd, _args, options) => windowsReply(options, { status: options.env.DEEPSEEK_TREE_PID === String(job.pid) ? 3 : 2 }));
  t.mock.method(childProcess, "spawn", () => {
    const child = Object.assign(new EventEmitter(), { pid: 40009, unref() {} });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  syncBuiltinESMExports();
  const started = await startJob(root, { prompt: "新的作业", permissionMode: "read-only" });
  assert.equal(started.status, "queued");
  assert.equal(fs.existsSync(path.join(dir, `${job.id}.json`)), false);
  assert.equal(fs.existsSync(job.logPath), false);
  assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith(".json") && !name.endsWith(".request.json")).length, 50);
});

test("第 51 个作业淘汰遇到身份查询失败时不遗留新记录、日志或启动说明", async (t) => {
  const { root, dir, job } = fixture(t, "win32");
  job.workerIdentity = { script: "worker.mjs", token };
  job.dshIdentity = { script: "host.mjs", token };
  await saveJob(root, job);
  for (let i = 1; i < 50; i++) {
    const id = `old-${i}`;
    const logPath = path.join(dir, `${id}.log`);
    fs.writeFileSync(logPath, "已有日志");
    await saveJob(root, { ...job, id, status: "completed", createdAt: "2021-01-01T00:00:00.000Z", logPath });
  }
  const original = fs.readdirSync(dir).sort();
  t.mock.method(childProcess, "spawnSync", (_cmd, _args, options) => windowsReply(options, { status: 1 }));
  syncBuiltinESMExports();
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(startJob(root, { prompt: "不应发布的作业", permissionMode: "read-only" }), /无法核实/);
    assert.deepEqual(fs.readdirSync(dir).sort(), original, "失败重试不能突破上限或留下没有 worker 的作业");
  }
});

test("macOS 同秒内 PID 和进程组复用仍须核对作业标识，不能卡在 running", async (t) => {
  const { root, job } = fixture(t, "darwin");
  job.workerIdentity = { platform: "darwin", startTime: "Mon Oct 19 10:00:00 2026", pgid: job.pid, bootId: null, token };
  job.dshIdentity = { ...job.workerIdentity };
  const signals = [];
  t.mock.method(process, "kill", (pid, signal) => { if (signal !== 0) signals.push([pid, signal]); return true; });
  t.mock.method(childProcess, "spawnSync", (_command, args) => ({ status: 0,
    stdout: args.includes("-A") ? `${job.pid} ${job.pid} Mon Oct 19 10:00:00 2026 S\n${process.pid} 50000 Mon Oct 19 10:00:00 2026 S\n` : "node unrelated.mjs DEEPSEEK_JOB_OWNER=other-job\n",
  }));
  syncBuiltinESMExports();
  await saveJob(root, job);
  assert.equal((await jobStatus(root, job.id)).status, "failed");
  assert.deepEqual(signals, []);
});

test("POSIX 启动 worker 时传递作业标识并持久化创建时间及进程组", async (t) => {
  const { root } = fixture(t, "linux");
  const processes = { [process.pid]: { pgid: 50000, startTime: "80" } };
  linuxBoundary(t, processes);
  t.mock.method(childProcess, "spawn", (_bin, _args, options) => {
    assert.equal(options.cwd, root);
    assert.equal(options.detached, true);
    assert.match(options.env.DEEPSEEK_JOB_OWNER, /^[\da-f-]{36}$/);
    processes[40009] = { pgid: 40009, startTime: "200", token: options.env.DEEPSEEK_JOB_OWNER };
    const child = Object.assign(new EventEmitter(), { pid: 40009, unref() {} });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  syncBuiltinESMExports();
  const job = await startJob(root, { prompt: "任务", permissionMode: "read-only" });
  assert.deepEqual(readJob(root, job.id).workerIdentity, {
    platform: "linux", startTime: "200", pgid: 40009, session: 40009, bootId: "boot-A", token: job.id,
  });
});

test("POSIX worker 尚未 spawn 的排队作业不冒用 companion 进程组并能恢复", async (t) => {
  const { root, dir } = fixture(t, "linux");
  const signals = linuxBoundary(t, {
    [process.pid]: { pgid: 50000, startTime: "80", token: null },
    50001: { pgid: 50000, startTime: "50", token: null },
  });
  let queued;
  t.mock.method(childProcess, "spawn", (_bin, args) => {
    queued = readJob(root, args[2]);
    throw new Error("模拟启动命令中断");
  });
  syncBuiltinESMExports();
  await assert.rejects(startJob(root, { prompt: "尚未启动", permissionMode: "read-only" }), /模拟启动命令中断/);
  assert.equal(queued.pid, null, "尚未创建 worker 时不能把 companion 当作 worker");
  assert.equal(queued.workerIdentity, null);
  // 重放 companion 没来得及写失败终态的崩溃现场。
  await saveJob(root, queued);
  const request = path.join(dir, `${queued.id}.request.json`);
  fs.writeFileSync(request, "{}");
  assert.equal((await jobStatus(root, queued.id)).status, "failed");
  assert.equal(fs.existsSync(request), false);
  assert.deepEqual(signals, [], "不得向 shell 或 companion 原进程组发送信号");
});

test("POSIX worker 身份登记失败后撤销启动说明，存活 worker 不能执行被拒绝的作业", async (t) => {
  const { root, dir } = fixture(t, "linux");
  const processes = {};
  const signals = linuxBoundary(t, processes);
  const read = fs.readFileSync;
  let failedQuery = false;
  t.mock.method(fs, "readFileSync", (target, ...args) => {
    if (!failedQuery && String(target) === "/proc/40009/stat") {
      failedQuery = true;
      throw Object.assign(new Error("瞬时查询失败"), { code: "EACCES" });
    }
    return read.call(fs, target, ...args);
  });
  let id;
  t.mock.method(childProcess, "spawn", (_bin, args, options) => {
    id = args[2];
    processes[40009] = { pgid: 40009, startTime: "200", token: options.env.DEEPSEEK_JOB_OWNER };
    const child = Object.assign(new EventEmitter(), { pid: 40009, unref() {} });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  syncBuiltinESMExports();
  await assert.rejects(startJob(root, { prompt: "不能执行或重试两次", permissionMode: "read-only" }), /无法核实/);
  await withJobsLock(root, () => {
    assert.equal(readJob(root, id).status, "failed", "释放锁前必须让 worker 看到启动已被拒绝");
    assert.equal(fs.existsSync(path.join(dir, `${id}.request.json`)), false);
  });
  assert.deepEqual(signals, [], "没有完成实例登记，不能向存活的旧 PID 发送信号");
});

test("POSIX runDsh 在发送任务正文前提供真实子进程实例身份", async (t) => {
  const { root } = fixture(t, "linux");
  linuxBoundary(t, { 40009: { pgid: 40009, startTime: "220", token } });
  const previous = process.env.DSH_BIN;
  process.env.DSH_BIN = fileURLToPath(new URL("./fake-dsh.mjs", import.meta.url));
  t.after(() => { if (previous === undefined) delete process.env.DSH_BIN; else process.env.DSH_BIN = previous; });
  const child = Object.assign(new EventEmitter(), { pid: 40009, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  let registered = false;
  child.stdin.once("data", () => {
    assert.equal(registered, true, "必须先登记身份再让 dsh 收到任务");
    child.stdout.write('{"type":"final","text":"完成"}\n{"type":"status","phase":"turn_end","reason":"completed"}\n');
    child.emit("message", { type: "deepseek-dsh-exit", exitCode: 0 });
    queueMicrotask(() => child.emit("close", null));
  });
  t.mock.method(childProcess, "spawn", (_bin, _args, options) => {
    assert.equal(options.env.DEEPSEEK_JOB_OWNER, token);
    assert.equal(options.detached, true);
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  syncBuiltinESMExports();
  const result = await runDsh({ cwd: root, prompt: "任务", permissionMode: "read-only", ownerToken: token, processGroup: true,
    onSpawn: (pid, identity) => {
      assert.equal(pid, 40009);
      assert.deepEqual(identity, { platform: "linux", startTime: "220", pgid: 40009, session: 40009, bootId: "boot-A", token });
      registered = true;
    },
  });
  assert.equal(result.ok, true);
});

test("POSIX 宿主身份登记失败时关闭输入并等待宿主退出，不启动未登记的 dsh", async (t) => {
  const { root } = fixture(t, "linux");
  const signals = linuxBoundary(t, { 40009: { pgid: 40009, startTime: "220", token } });
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (target, ...args) => {
    if (String(target) === "/proc/40009/stat") throw Object.assign(new Error("private data"), { code: "EACCES" });
    return read.call(fs, target, ...args);
  });
  const previous = process.env.DSH_BIN;
  process.env.DSH_BIN = fileURLToPath(new URL("./fake-dsh.mjs", import.meta.url));
  t.after(() => { if (previous === undefined) delete process.env.DSH_BIN; else process.env.DSH_BIN = previous; });
  const child = Object.assign(new EventEmitter(), { pid: 40009, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  let exited = false;
  let sent = false;
  let invocation;
  child.stdin.on("data", () => { sent = true; });
  child.stdin.once("close", () => { exited = true; child.emit("close", 1); });
  t.mock.method(childProcess, "spawn", (...args) => {
    invocation = args;
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  syncBuiltinESMExports();
  await assert.rejects(runDsh({ cwd: root, prompt: "不得执行", permissionMode: "read-only", ownerToken: token }), /无法核实/);
  assert.equal(child.stdin.destroyed, true, "失败后不能让已 spawn 的进程一直等待 stdin");
  assert.equal(exited, true, "必须等宿主退出后才能报告失败终态");
  assert.equal(sent, false);
  assert.match(invocation[1][0], /deepseek-dsh-host\.mjs$/);
  assert.deepEqual(signals, [], "未核实的 PID 不得被发送终止信号");
});

test("POSIX 独立宿主报告真实退出码后清理含 env-i 后代的整个进程组", async (t) => {
  const { root } = fixture(t, "linux");
  const signals = linuxBoundary(t, {
    40009: { pgid: 40009, startTime: "220", token },
    40011: { pgid: 40009, startTime: "230", token: null },
  });
  const previous = process.env.DSH_BIN;
  process.env.DSH_BIN = fileURLToPath(new URL("./fake-dsh.mjs", import.meta.url));
  t.after(() => { if (previous === undefined) delete process.env.DSH_BIN; else process.env.DSH_BIN = previous; });
  const child = Object.assign(new EventEmitter(), { pid: 40009, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  let invocation;
  child.stdin.once("data", () => {
    child.stdout.write('{"type":"final","text":"完成"}\n{"type":"status","phase":"turn_end","reason":"completed"}\n');
    child.emit("message", { type: "deepseek-dsh-exit", exitCode: 0 });
    queueMicrotask(() => child.emit("close", null));
  });
  t.mock.method(childProcess, "spawn", (...args) => {
    invocation = args;
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  syncBuiltinESMExports();
  const result = await runDsh({ cwd: root, prompt: "任务", permissionMode: "read-only", ownerToken: token });
  assert.equal(result.ok, true, "清理宿主时的信号退出不能覆盖真实 dsh 的成功退出码");
  assert.equal(result.exitCode, 0);
  assert.match(invocation[1][0], /deepseek-dsh-host\.mjs$/);
  assert.ok(invocation[2].stdio.includes("ipc"));
  assert.deepEqual(signals, [[-40009, "SIGKILL"]]);
});

test("POSIX 宿主崩溃后先清理仍存活的真实 dsh 和后代，再返回失败终态", async (t) => {
  const { root } = fixture(t, "linux");
  const processes = {
    40009: { pgid: 40009, startTime: "220", token },
    40010: { pgid: 40009, startTime: "230", token },
    40011: { pgid: 40009, startTime: "240", token: null },
  };
  const signals = linuxBoundary(t, processes, { onSignal: (pid) => {
    for (const [key, p] of Object.entries(processes)) if (p.pgid === -pid) delete processes[key];
  } });
  const previous = process.env.DSH_BIN;
  process.env.DSH_BIN = fileURLToPath(new URL("./fake-dsh.mjs", import.meta.url));
  t.after(() => { if (previous === undefined) delete process.env.DSH_BIN; else process.env.DSH_BIN = previous; });
  const child = Object.assign(new EventEmitter(), { pid: 40009, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  child.stdin.once("data", () => {
    delete processes[40009];
    child.emit("exit", null, "SIGKILL");
    child.emit("close", null, "SIGKILL");
  });
  t.mock.method(childProcess, "spawn", () => { queueMicrotask(() => child.emit("spawn")); return child; });
  syncBuiltinESMExports();
  const result = await runDsh({ cwd: root, prompt: "任务", permissionMode: "read-only", ownerToken: token });
  assert.equal(result.ok, false);
  assert.match(result.error, /宿主提前退出/);
  assert.deepEqual(signals, [[-40009, "SIGKILL"]]);
  assert.equal(processes[40010], undefined);
  assert.equal(processes[40011], undefined);
});

test("POSIX 完成后的组清理查询失败保留恢复入口，查询恢复后 status 清理宿主和后代", async (t) => {
  const { root, job } = fixture(t, "linux");
  posixIdentities(job);
  const processes = {
    [job.pid]: { pgid: job.pid, startTime: "100", token },
    40009: { pgid: 40009, startTime: "220", token },
    40011: { pgid: 40009, startTime: "230", token: null },
  };
  const signals = linuxBoundary(t, processes);
  const read = fs.readFileSync;
  let blocked = false;
  t.mock.method(fs, "readFileSync", (target, ...args) => {
    if (blocked && String(target) === "/proc/40009/stat") throw Object.assign(new Error("private data"), { code: "EACCES" });
    return read.call(fs, target, ...args);
  });
  const previous = process.env.DSH_BIN;
  process.env.DSH_BIN = fileURLToPath(new URL("./fake-dsh.mjs", import.meta.url));
  t.after(() => { if (previous === undefined) delete process.env.DSH_BIN; else process.env.DSH_BIN = previous; });
  const child = Object.assign(new EventEmitter(), { pid: 40009, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    connected: true, disconnect() { this.connected = false; }, unref() {},
  });
  child.stdin.once("data", () => {
    child.stdout.write('{"type":"final","text":"完成"}\n{"type":"status","phase":"turn_end","reason":"completed"}\n');
    blocked = true;
    child.emit("message", { type: "deepseek-dsh-exit", exitCode: 0 });
  });
  t.mock.method(childProcess, "spawn", () => { queueMicrotask(() => child.emit("spawn")); return child; });
  syncBuiltinESMExports();
  await assert.rejects(runDsh({ cwd: root, prompt: "任务", permissionMode: "read-only", ownerToken: token,
    onSpawn: async (pid, identity) => { job.dshPid = pid; job.dshIdentity = identity; await saveJob(root, job); },
  }), (error) => {
    assert.match(error.message, /无法核实/);
    assert.equal(error.cleanupPending, true);
    return true;
  });
  assert.deepEqual(signals, []);
  assert.equal(readJob(root, job.id).status, "running");
  // 模拟 worker 已退出，宿主仍持有组归属；下一次查询重试真实清理。
  delete processes[job.pid];
  blocked = false;
  assert.equal((await jobStatus(root, job.id)).status, "failed");
  assert.deepEqual(signals, [[-40009, "SIGKILL"]]);
});
