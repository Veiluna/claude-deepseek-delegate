import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { tmpDir } from "./helpers.mjs";
import { workspaceDir } from "../scripts/lib/state.mjs";
import { saveJob, readJob, jobStatus, jobResult, withJobsLock, startJob, cancelJob } from "../scripts/lib/jobs.mjs";
import { posixProcessIdentity, OWNER_ENV } from "../scripts/lib/posix-process.mjs";

function fixture(t) {
  const root = tmpDir("ds-job-state-");
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.CLAUDE_PLUGIN_DATA = path.join(root, "data");
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(root);
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
    if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const directory = path.join(workspaceDir(root), "jobs");
  const job = { id: "existing", kind: "task", status: "queued", pid: null, dshPid: null,
    createdAt: "2020-01-01T00:00:00.000Z", startedAt: null, finishedAt: null,
    claudeSessionId: null, logPath: path.join(directory, "existing.log") };
  fs.writeFileSync(job.logPath, "排队等待\n");
  return { root, directory, job };
}

test("失去启动进程的排队作业恢复为失败，并清理未消费的启动说明", async (t) => {
  const { root, directory, job } = fixture(t);
  await saveJob(root, job);
  fs.writeFileSync(path.join(directory, "existing.request.json"), "{}");
  const status = await jobStatus(root, job.id, { wait: true, timeoutMs: 100 });
  assert.equal(status.status, "failed");
  assert.ok(status.finishedAt);
  assert.equal(fs.existsSync(path.join(directory, "existing.request.json")), false);
  assert.equal(readJob(root, job.id).status, "failed");
});

test("取消进程中断后保留取消意图，恢复为已取消", async (t) => {
  const { root, job } = fixture(t);
  job.status = "running";
  job.cancelRequestedAt = new Date().toISOString();
  await saveJob(root, job);
  assert.equal((await jobStatus(root, job.id)).status, "cancelled");
});

test("result 默认按完成时间选择，忽略更新的失败或运行中作业", async (t) => {
  const { root, job } = fixture(t);
  await saveJob(root, { ...job, id: "slow", status: "completed", finishedAt: "2020-01-03T00:00:00.000Z", result: { ok: true, final: "最后完成的结果" } });
  await saveJob(root, { ...job, id: "fast", status: "completed", createdAt: "2020-01-02T00:00:00.000Z", finishedAt: "2020-01-02T01:00:00.000Z", result: { ok: true, final: "先完成的结果" } });
  await saveJob(root, { ...job, id: "failed", status: "failed", createdAt: "2020-01-04T00:00:00.000Z" });
  await saveJob(root, { ...job, id: "pending", status: "running", pid: process.pid, createdAt: "2020-01-05T00:00:00.000Z" });
  assert.equal((await jobResult(root)).final, "最后完成的结果");
  assert.equal((await jobResult(root, "fast")).final, "先完成的结果");
  await assert.rejects(jobResult(root, "pending"), /尚未结束/);
});

test("真实分离 worker 启动后返回编号，dsh 缺失时保存失败终态", async (t) => {
  const { root } = fixture(t);
  const previous = process.env.DSH_BIN;
  process.env.DSH_BIN = path.join(root, "missing-dsh");
  let job;
  try {
    job = await startJob(root, { prompt: "检查", permissionMode: "read-only" });
    assert.equal(job.status, "queued");
    assert.ok(job.pid > 0 && job.pid !== process.pid);
    const status = await jobStatus(root, job.id, { wait: true, timeoutMs: 10000 });
    assert.equal(status.status, "failed");
    assert.match(status.error, /DSH_BIN/);
  } finally {
    if (job) {
      try { process.kill(job.pid, "SIGKILL"); }
      catch (err) { if (err.code !== "ESRCH") throw err; }
    }
    if (previous === undefined) delete process.env.DSH_BIN;
    else process.env.DSH_BIN = previous;
  }
});

test("第 51 个作业清除最旧记录和日志，并发创建后仍只保留 50 个", async (t) => {
  const { root, directory, job } = fixture(t);
  const previous = process.env.DSH_BIN;
  process.env.DSH_BIN = path.join(root, "missing-dsh");
  const created = [];
  try {
    fs.rmSync(job.logPath);
    for (let i = 0; i < 50; i++) {
      const id = `old-${String(i).padStart(2, "0")}`;
      const at = new Date(Date.UTC(2020, 0, 1, 0, 0, i)).toISOString();
      const logPath = path.join(directory, `${id}.log`);
      fs.writeFileSync(logPath, "已有日志\n");
      await saveJob(root, { ...job, id, status: "completed", createdAt: at, finishedAt: at, logPath });
    }
    created.push(await startJob(root, { prompt: "第 51 个作业", permissionMode: "read-only" }));
    assert.equal(fs.existsSync(path.join(directory, "old-00.json")), false);
    assert.equal(fs.existsSync(path.join(directory, "old-00.log")), false);
    created.push(...await Promise.all([1, 2].map((i) => startJob(root, { prompt: `并发作业 ${i}`, permissionMode: "read-only" }))));
    for (const started of created) assert.equal((await jobStatus(root, started.id, { wait: true, timeoutMs: 10000 })).status, "failed");
    for (const id of ["old-01", "old-02"]) {
      assert.equal(fs.existsSync(path.join(directory, `${id}.json`)), false);
      assert.equal(fs.existsSync(path.join(directory, `${id}.log`)), false);
    }
    assert.equal(fs.readdirSync(directory).filter((name) => name.endsWith(".json")).length, 50);
    assert.equal(fs.readdirSync(directory).filter((name) => name.endsWith(".log")).length, 50);
  } finally {
    for (const started of created) {
      try { process.kill(started.pid, "SIGKILL"); }
      catch (err) { if (err.code !== "ESRCH") throw err; }
    }
    if (previous === undefined) delete process.env.DSH_BIN;
    else process.env.DSH_BIN = previous;
  }
});

test("取消作业真实终止 worker、子进程和孙进程", async (t) => {
  const { root, job } = fixture(t);
  const record = path.join(root, "tree.jsonl");
  const script = fileURLToPath(new URL("./fake-process-tree.mjs", import.meta.url));
  const token = randomUUID();
  const child = spawn(process.execPath, [script, record, "worker", `--deepseek-owner=${token}`], {
    cwd: root, detached: true, windowsHide: true, stdio: "ignore",
    env: { ...process.env, [OWNER_ENV]: token },
  });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
  job.pid = child.pid;
  if (process.platform === "win32") job.workerIdentity = { script, token };
  else job.workerIdentity = posixProcessIdentity(child.pid, token);
  job.status = "running";
  await saveJob(root, job);
  let pids = [child.pid];
  try {
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(record) || fs.readFileSync(record, "utf8").trim().split("\n").length !== 3) {
      assert.ok(Date.now() < deadline, "等待三层进程树超时");
      await delay(20);
    }
    pids = fs.readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line).pid);
    const result = await cancelJob(root, job.id);
    assert.equal(result.status, "cancelled");
    for (const pid of pids) {
      let exited = false;
      while (Date.now() < deadline) {
        try { process.kill(pid, 0); }
        catch (err) { if (err.code === "ESRCH") { exited = true; break; } throw err; }
        if (process.platform === "linux" && fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z")) { exited = true; break; }
        await delay(20);
      }
      assert.equal(exited, true, `进程 ${pid} 应已退出`);
    }
    assert.equal((await cancelJob(root, job.id)).status, "cancelled");
  } finally {
    // 断言失败时也清理本测试创建的精确 PID，避免测试进程残留。
    for (const pid of pids.reverse()) {
      try { process.kill(pid, "SIGKILL"); }
      catch (err) { if (err.code !== "ESRCH") throw err; }
    }
  }
});

test("并发状态写入串行化，不丢失更新，也不留下锁或临时快照", async (t) => {
  const { root, directory, job } = fixture(t);
  job.count = 0;
  await saveJob(root, job);
  await Promise.all(Array.from({ length: 10 }, () => withJobsLock(root, async () => {
    const current = readJob(root, job.id);
    await delay(1);
    current.count++;
    await saveJob(root, current);
  })));
  assert.equal(readJob(root, job.id).count, 10);
  assert.deepEqual(fs.readdirSync(directory).sort(), ["existing.json", "existing.log"]);
});

test("多个查询同时恢复崩溃进程留下的锁，不会删除新持有者的锁", async (t) => {
  const { root, directory } = fixture(t);
  const lock = path.join(directory, ".lock");
  fs.mkdirSync(lock);
  // 0 不是合法持锁 PID；找一个本机不存在的正 PID 作为崩溃夹具。
  let deadPid = 2147483647;
  for (;;) {
    try { process.kill(deadPid, 0); deadPid--; }
    catch (err) { if (err.code === "ESRCH") break; throw err; }
  }
  fs.writeFileSync(path.join(lock, `${deadPid}-crashed`), "");
  let inside = 0;
  await Promise.all(Array.from({ length: 5 }, () => withJobsLock(root, async () => {
    assert.equal(inside++, 0);
    await delay(5);
    assert.equal(--inside, 0);
  })));
  assert.equal(fs.existsSync(lock), false);
});

test("status --wait 不带编号时绑定开始等待的作业", async (t) => {
  const { root, job } = fixture(t);
  job.pid = process.pid;
  job.status = "running";
  job.startedAt = job.createdAt;
  await saveJob(root, job);
  const pending = jobStatus(root, undefined, { wait: true, timeoutMs: 300 });
  await delay(50);
  await withJobsLock(root, async () => {
    await saveJob(root, { ...job, id: "newer", status: "completed", createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
  });
  const status = await pending;
  assert.equal(status.id, "existing");
  assert.equal(status.status, "running");
  assert.equal(status.timedOut, true);
});
