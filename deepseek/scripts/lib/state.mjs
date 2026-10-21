import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const WINDOWS_RENAME_RETRIES = 100;
const WINDOWS_RENAME_RETRY_DELAY_MS = 50;
const WINDOWS_RENAME_BUSY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

// Project root: git top-level, otherwise the given directory.
export function resolveWorkspaceRoot(cwd) {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (r.status === 0 && r.stdout.trim()) {
    return path.resolve(r.stdout.trim());
  }
  return path.resolve(cwd);
}

export function dataRoot() {
  return process.env.DEEPSEEK_DATA_DIR ? path.join(process.env.DEEPSEEK_DATA_DIR, "projects")
    : process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), ".claude", "plugins", "data", "deepseek");
}

export function workspaceDir(workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  // Preserve distinct project identities outside Windows, while keeping the existing Windows hash and directory name.
  const identity = process.platform === "win32" ? root.toLowerCase() : root;
  const hash = crypto.createHash("sha1").update(identity).digest("hex").slice(0, 12);
  const dir = path.join(dataRoot(), `${path.basename(root)}-${hash}`);
  fs.mkdirSync(path.join(dir, "jobs"), { recursive: true });
  return dir;
}

function stateFile(workspaceRoot) {
  return path.join(workspaceDir(workspaceRoot), "state.json");
}

export function loadState(workspaceRoot) {
  let file;
  try {
    file = stateFile(workspaceRoot);
  } catch (err) {
    throw new Error(`读取项目状态失败：${err.message}`);
  }
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { resumableThread: null };
    throw new Error(`读取项目状态失败：${err.message}`);
  }
  return parseState(text, file);
}

export function parseState(text, file) {
  let state;
  try {
    state = JSON.parse(text);
  } catch {
    // JSON parser diagnostics can include file contents; report the path without echoing stored text.
    throw new Error(`项目状态文件损坏（无效 JSON）：${file}`);
  }
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error(`项目状态文件结构损坏：${file}`);
  }
  const candidate = state.resumableThread;
  if (candidate != null && (typeof candidate !== "object" || Array.isArray(candidate)
    || typeof candidate.threadId !== "string" || !candidate.threadId.trim() || typeof candidate.summary !== "string")) {
    throw new Error(`项目状态文件结构损坏：${file}`);
  }
  return state;
}

export async function saveState(workspaceRoot, state) {
  return writeJsonAtomic(stateFile(workspaceRoot), state);
}

export async function writeJsonAtomic(target, state) {
  // Publish a complete snapshot without truncating the file held by other readers.
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx");
  try {
    try {
      fs.writeFileSync(fd, JSON.stringify(state, null, 2), "utf8");
    } finally {
      fs.closeSync(fd);
    }
    await renameAtomic(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

// JSON 快照与完整项目目录共用同一个 Windows 短暂占用重试协议。
export async function renameAtomic(source, target) {
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(source, target); return; }
    catch (err) {
      if (process.platform !== "win32" || !WINDOWS_RENAME_BUSY_CODES.has(err.code) || attempt >= WINDOWS_RENAME_RETRIES) throw err;
      await delay(WINDOWS_RENAME_RETRY_DELAY_MS);
    }
  }
}

export async function updateState(workspaceRoot, fn) {
  const state = loadState(workspaceRoot);
  fn(state);
  await saveState(workspaceRoot, state);
  return state;
}
