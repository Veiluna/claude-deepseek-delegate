#!/usr/bin/env node
import fs from "node:fs";
import { executeTask } from "./lib/task.mjs";
import { withJobsLock, readJob, saveJob, readRequest } from "./lib/jobs.mjs";
import { posixProcessIdentity } from "./lib/posix-process.mjs";

const [root, id] = process.argv.slice(2);
async function main() {
  let pending;
  let job;
  await withJobsLock(root, async () => {
    job = readJob(root, id);
    // companion 必须先持久化启动成功；未完成登记的 worker 只能退出。
    if (job.status !== "queued" || job.pid !== process.pid) return;
    job.pid = process.pid;
    if (process.platform !== "win32") job.workerIdentity = posixProcessIdentity(process.pid, id);
    const options = readRequest(root, id);
    job.status = "running";
    job.startedAt = new Date().toISOString();
    await saveJob(root, job);
    fs.appendFileSync(job.logPath, "作业开始运行。\n");
    let ready;
    const spawned = new Promise((resolve) => { ready = resolve; });
    pending = executeTask({ ...options, cwd: root, processGroup: false, ownerToken: job.id,
      onPatch: async (patchPath) => { job.patchPath = patchPath; await saveJob(root, job); },
      onSpawn: async (pid, identity) => { job.dshPid = pid; if (identity) job.dshIdentity = identity; await saveJob(root, job); ready(); },
      onEvent: (line) => fs.appendFileSync(job.logPath, line + "\n"),
    });
    pending.then(ready, ready);
    // 持锁到子进程 PID 持久化，取消不会跨过启动窗口。
    await spawned;
  });
  if (!pending) return;
  const r = await pending;
  await withJobsLock(root, async () => {
    job = readJob(root, id);
    if (job.status !== "running") return;
    job.status = job.cancelRequestedAt ? "cancelled" : r.ok ? "completed" : "failed";
    delete job.patchPath;
    job.finishedAt = new Date().toISOString();
    const { events, stdout, stderr, timedOut, ...result } = r;
    if (!job.cancelRequestedAt) job.result = { ...result, ...(r.ok ? {} : { stdout, stderr }) };
    fs.appendFileSync(job.logPath, `作业结束：${job.status}\n`);
    await saveJob(root, job);
  });
}

main().catch(async (err) => {
  try {
    await withJobsLock(root, async () => {
      const job = readJob(root, id);
      if (!["queued", "running"].includes(job.status)) return;
      if (!err.cleanupPending) {
        job.status = "failed";
        job.finishedAt = new Date().toISOString();
      }
      job.error = err.message;
      await saveJob(root, job);
    });
  } catch { process.stderr.write("作业状态保存失败，请用 status 恢复状态。\n"); }
  process.exitCode = 1;
});
