import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { workspaceDir, writeJsonAtomic } from "./state.mjs";
import { killTree } from "./dsh.mjs";
import { windowsProcessAlive, ProcessIdentityMismatchError } from "./windows-process.mjs";
import { posixProcessIdentity, posixProcessAlive, OWNER_ENV } from "./posix-process.mjs";
import { selfProcessInstance, processInstanceAlive } from "./process-instance.mjs";

const worker = fileURLToPath(new URL("../deepseek-worker.mjs", import.meta.url));
const active = (job) => ["queued", "running"].includes(job.status);
const currentSessionId = () => process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || null;
const directory = (root) => path.join(workspaceDir(root), "jobs");
function jobFile(root, id, suffix = ".json") {
  if (!/^[\w-]+$/.test(id ?? "")) throw new Error("无效的作业编号。");
  return path.join(directory(root), id + suffix);
}

export function isAlive(pid, identity) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === "win32" && identity) return windowsProcessAlive(pid, identity);
  if (process.platform !== "win32" && identity) return posixProcessAlive(pid, identity);
  try {
    process.kill(pid, 0);
    // 容器的 PID 1 可能延迟回收僵尸进程；它们已经不能继续执行作业。
    if (process.platform === "linux" && fs.existsSync("/proc/self/stat")) {
      const state = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)?.[0];
      if (state === "Z" || state === "X") return false;
    }
    return true;
  }
  catch (err) { if (["ESRCH", "ENOENT"].includes(err.code)) return false; throw err; }
}

// 目录 rename 一次发布已写入 owner 的完整代际，不暴露可被回收的空锁。
export async function withJobsLock(root, fn) {
  const dir = directory(root);
  const lock = path.join(dir, ".lock");
  const token = `${process.pid}-${crypto.randomUUID()}`;
  const prepared = path.join(dir, `.lock-${token}.tmp`);
  const removeEmpty = (target) => {
    try { fs.rmdirSync(target); }
    catch (err) {
      if (["ENOENT", "ENOTEMPTY", "EEXIST"].includes(err.code)) return;
      // Windows 对非空目录也可能返回 EPERM/EACCES；只容忍确实已有新 owner 的情况。
      if (["EPERM", "EACCES"].includes(err.code)) {
        try { if (fs.readdirSync(target).length) return; }
        catch (readError) { if (readError.code === "ENOENT") return; throw readError; }
      }
      throw err;
    }
  };
  fs.mkdirSync(prepared);
  let acquired = false;
  try {
    fs.writeFileSync(path.join(prepared, token), JSON.stringify({ ...selfProcessInstance(), publishedAt: Date.now() }), { flag: "wx" });
    const deadline = Date.now() + 15000;
    for (;;) {
      if (Date.now() >= deadline) throw new Error("等待作业状态锁超时。");
      try { fs.renameSync(prepared, lock); acquired = true; break; }
      catch (err) {
        // 竞争者可能已在 rename 失败后释放锁；目标消失同样应该重试原子发布。
        if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(err.code)) throw err;
        try {
          for (const owner of fs.readdirSync(lock)) {
            const pid = Number(owner.split("-")[0]);
            if (!pid) continue;
            let contents;
            try { contents = fs.readFileSync(path.join(lock, owner), "utf8"); }
            catch (readError) {
              // Windows 在 owner 关闭/删除期间可能短暂拒绝读取。
              // 未读到身份就保留该 owner，只等待下轮，不能回收或进入临界区。
              if (["EPERM", "EACCES"].includes(readError.code)) continue;
              throw readError;
            }
            // 旧版本空 owner 只在 PID 确实退出时回收，新 owner 必须核对创建时间。
            const instance = contents ? JSON.parse(contents) : null;
            const age = instance ? Date.now() - instance.publishedAt : Infinity;
            // 活锁只等待；延后昂贵的跨进程实例查询，避免轮询者错过短暂的解锁窗口。
            // 宽限只延后查询，绝不会凭时间回收锁；回收仍必须确认原实例已退出。
            const fresh = pid !== process.pid && age >= 0 && age < 2000;
            const alive = fresh ? isAlive(pid) : instance ? processInstanceAlive(pid, instance) : isAlive(pid);
            if (!alive) fs.rmSync(path.join(lock, owner), { force: true });
          }
          // 只删除空目录；旧回收者只能删除观察过的唯一 owner 文件，碰不到新代际。
          removeEmpty(lock);
        } catch (readError) { if (readError.code !== "ENOENT") throw readError; }
        await delay(25);
      }
    }
    return await fn();
  } finally {
    const owned = acquired ? lock : prepared;
    fs.rmSync(path.join(owned, token), { force: true });
    removeEmpty(owned);
  }
}

export function readJob(root, id) {
  const file = jobFile(root, id);
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (err) {
    if (err.code === "ENOENT") throw new Error(`找不到作业：${id}`);
    throw new Error(`作业记录无法读取：${id}`);
  }
}

export const saveJob = (root, job) => writeJsonAtomic(jobFile(root, job.id), job);
const allJobs = (root) => fs.readdirSync(directory(root))
  .filter((name) => name.endsWith(".json") && !name.endsWith(".request.json"))
  .map((name) => readJob(root, name.slice(0, -5)))
  .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

function stopJob(job, { recovering = false } = {}) {
  // Windows 的 dshPid 是持有管道的独立宿主，不依赖 cmd.exe 的寿命。
  for (const [pid, identity, isWorker] of [[job.dshPid, job.dshIdentity, false], [job.pid, job.workerIdentity, true]]) {
    if (!pid) continue;
    if (process.platform === "win32" && !identity) {
      if (!isAlive(pid)) continue;
      throw new Error("旧作业缺少 Windows 进程身份，无法安全清理；拒绝终止未经核对的 PID。");
    }
    if (process.platform === "win32" && isWorker && !isAlive(pid, identity)) continue;
    if (process.platform !== "win32" && !identity) {
      if (!isAlive(pid)) continue;
      throw new Error("旧作业缺少 POSIX 进程身份，无法安全清理；拒绝终止未经核对的 PID。");
    }
    // 兼容 dsh 与 worker 共组的记录：组长的创建时间同样已持久化，
    // 即使复用该 PGID 的普通进程没有作业环境标识，也能确认原组已消失。
    const leader = process.platform === "win32" ? null : job.pid === identity?.pgid ? job.workerIdentity : job.dshPid === identity?.pgid ? job.dshIdentity : null;
    const checked = leader ? { ...identity, groupLeaderStartTime: leader.startTime } : identity;
    try { killTree({ pid, identity: checked }); }
    catch (err) { if (!recovering || !(err instanceof ProcessIdentityMismatchError)) throw err; }
  }
  if (job.patchPath) {
    const patch = path.resolve(job.patchPath);
    const dir = path.dirname(patch);
    // 只删除运行器创建的临时覆盖目录，不把记录中的任意路径当作删除目标。
    if (path.basename(patch) !== "patch.json" || !path.basename(dir).startsWith("deepseek-patch-") ||
      path.dirname(dir) !== path.resolve(os.tmpdir())) throw new Error("作业临时配置路径无效，未删除。");
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function recover(root, job) {
  if (active(job) && (job.cancelRequestedAt || !isAlive(job.pid, job.workerIdentity))) {
    stopJob(job, { recovering: true });
    job.status = job.cancelRequestedAt ? "cancelled" : "failed";
    job.finishedAt = new Date().toISOString();
    if (!job.cancelRequestedAt) job.error = "作业 worker 已退出，未留下完整结果。";
    fs.rmSync(jobFile(root, job.id, ".request.json"), { force: true });
    await saveJob(root, job);
  }
  return job;
}

export async function startJob(root, options) {
  return withJobsLock(root, async () => {
    const id = crypto.randomUUID();
    const job = {
      id, kind: options.kind || "task", status: "queued", pid: null, dshPid: null,
      createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
      claudeSessionId: currentSessionId(), workspaceRoot: root,
      logPath: jobFile(root, id, ".log"),
      workerIdentity: process.platform === "win32" ? { script: worker, token: id } : null,
    };
    const jobs = allJobs(root);
    // 先为新作业腾出位置；清理失败时不能发布一个没有 worker 的第 51 条记录。
    for (const oldest of jobs.slice(0, Math.max(0, jobs.length - 49))) {
      // 淘汰运行中的最旧作业时先清理进程，避免 worker 重建已删记录。
      if (active(oldest)) stopJob(oldest, { recovering: true });
      for (const suffix of [".log", ".request.json", ".json"]) fs.rmSync(jobFile(root, oldest.id, suffix), { force: true });
    }
    fs.writeFileSync(job.logPath, "");
    await saveJob(root, job);
    await writeJsonAtomic(jobFile(root, id, ".request.json"), options);
    const fd = fs.openSync(job.logPath, "a");
    let child;
    try {
      child = spawn(process.execPath, [worker, root, id, `--deepseek-owner=${id}`], {
        cwd: root, detached: true, windowsHide: true, stdio: ["ignore", fd, fd],
        env: { ...process.env, [OWNER_ENV]: id },
      });
      child.deepseekIdentity = job.workerIdentity;
      await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      job.pid = child.pid;
      if (process.platform !== "win32") {
        job.workerIdentity = posixProcessIdentity(child.pid, id);
        child.deepseekIdentity = job.workerIdentity;
      }
      await saveJob(root, job);
      child.unref();
    } catch (err) {
      // worker 正在等待同一把锁；先撤销任务，再尝试清理，清理失败不能放行它。
      job.status = "failed";
      job.finishedAt = new Date().toISOString();
      job.error = `启动作业失败：${err.message}`;
      fs.rmSync(jobFile(root, id, ".request.json"), { force: true });
      await saveJob(root, job);
      child?.unref();
      if (child?.pid && child.deepseekIdentity) killTree(child);
      throw err;
    } finally { fs.closeSync(fd); }
    return job;
  });
}

function progress(job) {
  let fd;
  try { fd = fs.openSync(job.logPath, "r"); }
  catch (err) { if (err.code === "ENOENT") return []; throw err; }
  try {
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, 16384));
    fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    return buffer.toString("utf8").split(/\r?\n/).filter(Boolean).slice(-5).map((s) => s.slice(0, 500));
  } finally { fs.closeSync(fd); }
}

async function statuses(root, id, { wait = false, timeoutMs, claudeSessionId = currentSessionId(), all = false } = {}, list = false) {
  const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
  let ids;
  for (;;) {
    const jobs = await withJobsLock(root, async () => {
      let selected = ids ? ids.map((key) => readJob(root, key)) : id ? [readJob(root, id)] : allJobs(root);
      if (!all) selected = selected.filter((job) => (job.claudeSessionId ?? null) === claudeSessionId);
      if (!list) {
        selected = selected.slice(-1);
        if (!selected.length) throw new Error("当前 Claude 会话没有该作业，可用 --all 查看项目作业。");
      }
      ids ??= selected.map((job) => job.id);
      for (const job of selected) await recover(root, job);
      return selected.map((job) => ({ ...job, progress: progress(job) }));
    });
    const timedOut = wait && jobs.some(active) && Date.now() >= deadline;
    if (!wait || !jobs.some(active) || timedOut) return jobs.map((job) => ({
      ...job, elapsedMs: Math.max(0, Date.parse(job.finishedAt || new Date().toISOString()) - Date.parse(job.startedAt || job.createdAt)),
      ...(timedOut && active(job) ? { timedOut: true } : {}),
    }));
    await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  }
}

export const jobStatus = async (root, id, options) => (await statuses(root, id, options))[0];
export const jobStatuses = (root, options) => statuses(root, undefined, options, true);

// 同一 Claude 会话可通过 --cwd 在多个项目创建作业。新记录保留根目录，
// 当前根目录同时兼容 #6 未保存 workspaceRoot 的记录。
export async function cleanSessionJobs(root, claudeSessionId, { before = Date.now() } = {}) {
  if (typeof claudeSessionId !== "string" || !claudeSessionId) throw new Error("缺少所属 Claude 会话编号。");
  const roots = new Set([root]);
  const data = path.dirname(workspaceDir(root));
  for (const entry of fs.readdirSync(data, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const project = path.join(data, entry.name);
    const jobs = path.join(project, "jobs");
    if (!fs.existsSync(jobs)) continue;
    for (const name of fs.readdirSync(jobs).filter((name) => name.endsWith(".json") && !name.endsWith(".request.json"))) {
      let record;
      try { record = JSON.parse(fs.readFileSync(path.join(jobs, name), "utf8")); }
      catch (err) { if (err.code === "ENOENT") continue; throw err; }
      if (record.claudeSessionId === claudeSessionId && typeof record.workspaceRoot === "string" && path.isAbsolute(record.workspaceRoot) &&
        path.resolve(workspaceDir(record.workspaceRoot)) === path.resolve(project)) roots.add(record.workspaceRoot);
    }
  }
  const belongs = (job) => job.claudeSessionId === claudeSessionId && Date.parse(job.createdAt) <= before;
  let failed = false;
  for (const projectRoot of roots) {
    const ids = await withJobsLock(projectRoot, () => allJobs(projectRoot).filter(belongs).map((job) => job.id));
    for (const id of ids) {
      const job = await withJobsLock(projectRoot, async () => {
        if (!fs.existsSync(jobFile(projectRoot, id))) return null;
        const current = readJob(projectRoot, id);
        if (!belongs(current)) return null;
        if (active(current)) {
          current.cancelRequestedAt ||= new Date().toISOString();
          await saveJob(projectRoot, current);
        }
        return current;
      });
      if (!job) continue;
      // 先持久化取消意图，再在锁外结束进程树，其他 Claude 会话仍可更新状态。
      // queued worker 也检查该意图，不会在释放锁后启动新的 dsh。
      try { if (active(job)) stopJob(job, { recovering: true }); }
      catch (err) {
        failed = true;
        await withJobsLock(projectRoot, async () => {
          if (!fs.existsSync(jobFile(projectRoot, id))) return;
          const current = readJob(projectRoot, id);
          current.error = `Claude 会话结束时清理失败：${err.message}`;
          await saveJob(projectRoot, current);
        });
        continue;
      }
      await withJobsLock(projectRoot, () => {
        if (!fs.existsSync(jobFile(projectRoot, id)) || !belongs(readJob(projectRoot, id))) return;
        for (const suffix of [".log", ".request.json", ".json"]) fs.rmSync(jobFile(projectRoot, id, suffix), { force: true });
      });
    }
  }
  if (failed) throw new Error("部分作业清理失败，已保留记录与取消意图供恢复。");
}

export async function jobResult(root, id) {
  return withJobsLock(root, async () => {
    const job = id ? await recover(root, readJob(root, id)) : allJobs(root)
      .filter((j) => j.status === "completed").sort((a, b) => a.finishedAt.localeCompare(b.finishedAt)).at(-1);
    if (!job) throw new Error("当前项目没有已完成的作业。");
    if (active(job)) throw new Error(`作业尚未结束：${job.id}（${job.status}）`);
    return { id: job.id, kind: job.kind, status: job.status, ...(job.result || { ok: false, final: null, error: job.error || "作业已取消。" }) };
  });
}

export async function cancelJob(root, id) {
  if (!id) throw new Error("cancel 必须提供作业编号。");
  return withJobsLock(root, async () => {
    const job = await recover(root, readJob(root, id));
    if (active(job)) {
      job.cancelRequestedAt = new Date().toISOString();
      await saveJob(root, job);
      stopJob(job);
      job.status = "cancelled";
      job.finishedAt = new Date().toISOString();
      fs.rmSync(jobFile(root, id, ".request.json"), { force: true });
      await saveJob(root, job);
    }
    return job;
  });
}

export function readRequest(root, id) {
  const file = jobFile(root, id, ".request.json");
  const options = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.rmSync(file);
  return options;
}
