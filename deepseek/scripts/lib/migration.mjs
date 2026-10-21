import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseState, renameAtomic, writeJsonAtomic } from "./state.mjs";
import { withJobsDirectoryLock } from "./jobs.mjs";
import { assertDirectoryPath, withDataRootLock } from "./shared-data.mjs";

function parseJson(bytes, file) {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new Error(`迁移记录损坏：${file}`); }
}

// 锁目录不是用户数据；复制前后对其他所有文件重新取快照，检测旧调用并发写入。
function snapshot(root) {
  const files = new Map();
  function visit(dir, relative = "") {
    for (const name of fs.readdirSync(dir).sort()) {
      if (path.basename(dir) === "jobs" && (name === ".lock" || /^\.lock-.*\.tmp$/.test(name))) continue;
      const file = path.join(dir, name);
      const key = path.join(relative, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`迁移拒绝不安全路径：${file}`);
      if (stat.isDirectory()) visit(file, key);
      else if (stat.isFile()) files.set(key, fs.readFileSync(file));
      else throw new Error(`迁移拒绝非普通文件：${file}`);
    }
  }
  visit(root);
  return files;
}

const inside = (parent, child) => {
  const rel = path.relative(parent, child);
  return !rel || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
};

function normalDirectory(dir) {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`迁移拒绝不安全目录：${dir}`);
}

function checkTarget(target) {
  if (!fs.existsSync(target)) return;
  normalDirectory(target);
  if (fs.readdirSync(target).length) throw new Error("迁移目标已有数据，未覆盖任何内容。");
}

function planSnapshot(source, projects, files) {
  const consumed = new Set();
  const plans = projects.map((name) => {
    const stateKey = path.join(name, "state.json");
    let state;
    if (files.has(stateKey)) {
      try { state = parseState(files.get(stateKey).toString("utf8"), stateKey); }
      catch { throw new Error(`迁移候选记录损坏：${stateKey}`); }
      consumed.add(stateKey);
    }
    const jobs = [];
    for (const [key, bytes] of files) {
      if (path.dirname(key) !== path.join(name, "jobs") || !key.endsWith(".json") || key.endsWith(".request.json")) continue;
      const job = parseJson(bytes, key);
      if (["queued", "running"].includes(job.status)) throw new Error(`迁移遇到活动作业：${key}`);
      if (!["completed", "failed", "cancelled"].includes(job.status)) throw new Error(`迁移作业状态未知，未按终态处理：${key}`);
      const timestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
      if (typeof job.id !== "string" || !/^[\w-]+$/.test(job.id) || path.basename(key) !== `${job.id}.json` || !timestamp(job.createdAt) || !timestamp(job.finishedAt) ||
        (job.startedAt != null && !timestamp(job.startedAt))) throw new Error(`迁移作业记录损坏：${key}`);
      const logKey = path.join(name, "jobs", `${job.id}.log`);
      const expected = path.join(source, logKey);
      if (typeof job.logPath !== "string" || !path.isAbsolute(job.logPath) || path.relative(expected, path.resolve(job.logPath)) !== "") {
        throw new Error(`迁移日志路径不安全：${key}`);
      }
      if (!files.has(logKey)) throw new Error(`迁移缺少配套日志：${key}`);
      for (const suffix of [".json", ".log", ".request.json"]) consumed.add(path.join(name, "jobs", job.id + suffix));
      jobs.push({ key, logKey, job });
    }
    return { name, state, jobs };
  });
  for (const key of files.keys()) if (!consumed.has(key)) throw new Error(`迁移发现无法识别的数据文件：${key}`);
  return plans;
}

export async function migrateData(from, to) {
  const source = path.resolve(from);
  const target = path.resolve(to);
  assertDirectoryPath(source);
  normalDirectory(source);
  if (inside(source, target) || inside(target, source)) throw new Error("迁移源与目标不能相同或互相包含。");
  return withDataRootLock(target, async () => {
    checkTarget(target);
    const projects = fs.readdirSync(source).sort();
    for (const name of projects) {
      if (!/^.+-[a-f0-9]{12}$/.test(name)) throw new Error(`迁移发现无法识别的项目目录：${name}`);
      normalDirectory(path.join(source, name));
      normalDirectory(path.join(source, name, "jobs"));
    }
    const locked = async (index) => {
      if (index < projects.length) return withJobsDirectoryLock(path.join(source, projects[index], "jobs"), () => locked(index + 1));
      const original = snapshot(source);
      if (JSON.stringify(fs.readdirSync(source).sort()) !== JSON.stringify(projects)) throw new Error("迁移期间源项目发生变化；请停止旧调用后重试。");
      const plans = planSnapshot(source, projects, original);
      const stage = path.join(path.dirname(target), `.${path.basename(target)}.migration-${crypto.randomUUID()}.tmp`);
      fs.mkdirSync(stage, { mode: 0o700 });
      let jobs = 0;
      // 所有输出都留在不可消费的根外暂存目录，最后一次 rename 发布完整快照。
      for (const { name, state, jobs: records } of plans) {
        const project = path.join(stage, name);
        fs.mkdirSync(path.join(project, "jobs"), { recursive: true, mode: 0o700 });
        if (state !== undefined) await writeJsonAtomic(path.join(project, "state.json"), state);
        for (const { key, logKey, job } of records) {
          fs.writeFileSync(path.join(stage, logKey), original.get(logKey));
          await writeJsonAtomic(path.join(stage, key), { ...job, logPath: path.join(target, logKey) });
          jobs++;
        }
      }
      const after = snapshot(source);
      if (JSON.stringify(fs.readdirSync(source).sort()) !== JSON.stringify(projects) || after.size !== original.size || [...original].some(([key, bytes]) => !after.get(key)?.equals(bytes))) {
        throw new Error("迁移期间源数据发生变化；请停止旧调用后重试。");
      }
      checkTarget(target);
      if (fs.existsSync(target)) fs.rmdirSync(target);
      await renameAtomic(stage, target);
      return { source, target, projects: projects.length, jobs };
    };
    return locked(0);
  });
}
