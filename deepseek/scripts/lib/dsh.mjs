import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

// Appended to every message sent to DeepSeek (ADR-0004: headless has no approver).
export const PREAMBLE = [
  "",
  "---",
  "运行约束：只在当前工作区内写入文件；不要请求提升权限（需要授权的操作会被直接拒绝）；覆盖已有文件前先读取它。",
].join("\n");

export class DshNotFoundError extends Error {}

const WIN_EXTS = [".cmd", ".exe", ".bat", ""];

function candidatesFor(base) {
  return process.platform === "win32" ? WIN_EXTS.map((e) => base + e) : [base];
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function defaultInstallDirs() {
  const home = os.homedir();
  const dirs = [path.join(home, ".dsh", "bin"), path.join(home, ".local", "bin")];
  if (process.platform === "win32") {
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, "npm"));
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, "Programs", "dsh"));
  } else {
    dirs.push("/usr/local/bin", "/opt/homebrew/bin");
  }
  return dirs;
}

// Lookup order: DSH_BIN, PATH, default install locations.
export function findDsh(env = process.env) {
  if (env.DSH_BIN) {
    if (isFile(env.DSH_BIN)) return env.DSH_BIN;
    throw new DshNotFoundError(`DSH_BIN 指向的文件不存在：${env.DSH_BIN}`);
  }
  const pathDirs = (env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
  for (const dir of [...pathDirs, ...defaultInstallDirs()]) {
    for (const file of candidatesFor(path.join(dir, "dsh"))) {
      if (isFile(file)) return file;
    }
  }
  throw new DshNotFoundError("找不到 dsh（已检查 DSH_BIN、PATH 和默认安装路径）。");
}

function spawnDsh(bin, args, options) {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(bin)) {
    const line = [bin, ...args].map((a) => `"${a}"`).join(" ");
    return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
      ...options,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(bin, args, options);
}

// Parse the headless --json event stream. Only `final` is untruncated.
export function parseEvents(stdout) {
  const result = { threadId: null, final: null, reason: null, error: null, events: [] };
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!ev || typeof ev !== "object") continue;
    result.events.push(ev);
    const type = ev.type ?? ev.event;
    if (type === "session") {
      result.threadId = ev.sessionId ?? ev.session_id ?? ev.id ?? ev.session?.id ?? result.threadId;
    } else if (type === "status" && ev.phase === "turn_end") {
      result.reason = ev.reason?.kind ?? ev.reason ?? null;
    } else if (type === "final") {
      result.final = ev.text ?? "";
    } else if (type === "error") {
      result.error = ev.message ?? ev.error ?? JSON.stringify(ev);
    }
  }
  return result;
}

// Run one headless turn. Resolves with { ok, exitCode, threadId, final, reason, error, stdout, stderr }.
export function runDsh({ prompt, cwd, permissionMode, threadId, onEvent }) {
  const bin = findDsh();
  const args = ["--profile", "headless", "--json"];
  if (threadId) args.push("--session-id", threadId);
  args.push("-");
  const env = { ...process.env, DSH_PERMISSION_MODE: permissionMode };
  return new Promise((resolve, reject) => {
    const child = spawnDsh(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let pending = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!onEvent) return;
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) onEvent(line);
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const parsed = parseEvents(stdout);
      const ok = code === 0 && parsed.final !== null && parsed.reason === "completed";
      resolve({ ok, exitCode: code, ...parsed, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(Buffer.from(prompt + PREAMBLE, "utf8"));
  });
}
