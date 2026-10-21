import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { sharedDataRoot } from "./host-context.mjs";
import { writeJsonAtomic } from "./state.mjs";
import { withJobsDirectoryLock } from "./jobs.mjs";

export function ownerDirectory(context) {
  if (!["claude", "codex"].includes(context?.host) || typeof context.sessionId !== "string" || !context.sessionId.trim() || context.sessionId.includes("\0")) {
    throw new Error("缺少宿主主线程身份；请使用已登记的主线程，或使用前台任务。");
  }
  const key = crypto.createHash("sha256").update(context.sessionId).digest("hex");
  return path.join(sharedDataRoot(), "hosts", context.host, key);
}

function validateOwner(record, context) {
  if (!record || typeof record !== "object" || Array.isArray(record) || record.host !== context.host || record.sessionId !== context.sessionId) {
    throw new Error("宿主会话登记身份无效。");
  }
  if (!Number.isSafeInteger(record.lastSequence) || record.lastSequence < 0 || !Array.isArray(record.workspaceRoots) ||
    record.workspaceRoots.some(root => typeof root !== "string" || !path.isAbsolute(root) || root.includes("\0"))) {
    throw new Error("宿主会话登记序号或项目集合损坏。");
  }
  return record;
}

export function readHostOwner(context, { optional = false } = {}) {
  const file = path.join(ownerDirectory(context), "session.json");
  let record;
  try { record = fs.readFileSync(file, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") {
      if (optional) return null;
      throw new Error("当前宿主线程没有 SessionStart 登记；请检查 /hooks 的启用与信任状态，或使用前台任务。");
    }
    throw new Error("宿主会话登记无法读取。");
  }
  try { record = JSON.parse(record); }
  catch { throw new Error("宿主会话登记损坏（无效 JSON）。"); }
  return validateOwner(record, context);
}

export async function registerHostSession(context) {
  const dir = ownerDirectory(context);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return withJobsDirectoryLock(dir, async () => {
    const previous = readHostOwner(context, { optional: true });
    const roots = new Set(previous?.workspaceRoots || []);
    roots.add(context.workspaceRoot);
    const record = { ...previous, host: context.host, sessionId: context.sessionId,
      workspaceRoot: context.workspaceRoot, transcriptSource: context.transcriptSource,
      workspaceRoots: [...roots], lastSequence: previous?.lastSequence ?? 0 };
    await writeJsonAtomic(path.join(dir, "session.json"), record);
    return record;
  });
}

// 调用方持项目 jobs 锁；owner 锁仅覆盖预留序号、项目集合与初始记录发布。
export async function publishOwnedJob(context, root, publish) {
  const dir = ownerDirectory(context);
  return withJobsDirectoryLock(dir, async () => {
    const record = readHostOwner(context);
    if (record.lastSequence === Number.MAX_SAFE_INTEGER) throw new Error("宿主会话作业序号已耗尽。");
    const ownerSequence = record.lastSequence + 1;
    const roots = new Set(record.workspaceRoots);
    roots.add(root);
    await writeJsonAtomic(path.join(dir, "session.json"), { ...record, lastSequence: ownerSequence, workspaceRoots: [...roots] });
    // 序号先提交；中断可留下空洞，但不会重新使用旧围栏以内的编号。
    return publish(ownerSequence);
  });
}

export function validateSnapshot(snapshot) {
  ownerDirectory(snapshot);
  if (!Number.isSafeInteger(snapshot.fence) || snapshot.fence < 0 || !Array.isArray(snapshot.roots) ||
    snapshot.roots.some(root => typeof root !== "string" || !path.isAbsolute(root) || root.includes("\0"))) {
    throw new Error("宿主会话清理围栏无效。");
  }
  return snapshot;
}

export function captureOwnerSnapshot(context) {
  const record = readHostOwner(context);
  return { host: record.host, sessionId: record.sessionId, fence: record.lastSequence, roots: [...record.workspaceRoots] };
}
