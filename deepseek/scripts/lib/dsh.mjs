import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { buildPatches, withPatch } from "./config-patch.mjs";

// Appended to every message sent to DeepSeek (ADR-0004: headless has no approver).
export const PREAMBLE = [
  "",
  "---",
  "运行约束：只在当前工作区内写入文件；不要请求提升权限（需要授权的操作会被直接拒绝）；覆盖已有文件前先读取它。",
].join("\n");

export class DshNotFoundError extends Error {
  // reason: "bad-dsh-bin" (DSH_BIN points at a missing file) or "not-found".
  constructor(message, reason) {
    super(message);
    this.reason = reason;
  }
}

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
    for (const root of [process.env.ProgramFiles, process.env.ProgramW6432, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs")]) {
      if (!root) continue;
      dirs.push(path.join(root, "DeepSeek Harness"), path.join(root, "DeepSeek Harness", "bin"));
    }
  } else {
    dirs.push("/usr/local/bin", "/opt/homebrew/bin");
  }
  return dirs;
}

// Lookup order: DSH_BIN, PATH, default install locations.
export function findDsh(env = process.env) {
  if (env.DSH_BIN) {
    if (isFile(env.DSH_BIN)) return env.DSH_BIN;
    throw new DshNotFoundError(`DSH_BIN 指向的文件不存在：${env.DSH_BIN}`, "bad-dsh-bin");
  }
  const pathDirs = (env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
  for (const dir of [...pathDirs, ...defaultInstallDirs()]) {
    for (const file of candidatesFor(path.join(dir, "dsh"))) {
      if (isFile(file)) return file;
    }
  }
  throw new DshNotFoundError("找不到 dsh（已检查 DSH_BIN、PATH 和默认安装路径）。", "not-found");
}

// Windows .cmd/.bat shims must go through the command interpreter.
function dshCommand(bin, args) {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(bin)) {
    const line = [bin, ...args].map((a) => `"${a}"`).join(" ");
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", `"${line}"`],
      extra: { windowsVerbatimArguments: true },
    };
  }
  return { command: bin, args, extra: {} };
}

function spawnDsh(bin, args, options) {
  const c = dshCommand(bin, args);
  return spawn(c.command, c.args, { ...options, ...c.extra });
}

// `dsh --version` output, or null when it cannot be read.
export function dshVersion(bin) {
  const c = dshCommand(bin, ["--version"]);
  // Read-only and no stdin, in case this dsh treats --version as a prompt.
  const r = spawnSync(c.command, c.args, {
    ...c.extra,
    env: { ...process.env, DSH_PERMISSION_MODE: "read-only" },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
  });
  const text = (r.stdout || "").trim();
  return r.status === 0 && text ? text.split(/\r?\n/)[0] : null;
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

function killTree(child) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

// Run one headless turn. Resolves with { ok, exitCode, threadId, final, reason, error, timedOut, stdout, stderr }.
export async function runDsh({ prompt, cwd, permissionMode, threadId, onEvent, timeoutMs, model, effort }) {
  const bin = findDsh();
  const env = { ...process.env, DSH_PERMISSION_MODE: permissionMode };
  if (model !== undefined || effort !== undefined) {
    const c = dshCommand(bin, ["--profile", "headless", "--dump-config"]);
    let dump;
    try {
      dump = spawnSync(c.command, c.args, {
        ...c.extra, cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        timeout: 15000, windowsHide: true,
      });
    } catch {
      throw new Error("读取 dsh 配置失败（--dump-config），未启动任务。");
    }
    if (dump.error || dump.status !== 0) throw new Error("读取 dsh 配置失败（--dump-config），未启动任务。");
    const patches = buildPatches(dump.stdout, { model, effort });
    return withPatch(patches, async (patch) => {
      const result = await runTurn({ bin, env, prompt, cwd, threadId, timeoutMs, patch });
      // dsh may echo config validation errors, including secrets from the patch.
      // Keep ordinary task output unchanged; overridden failures expose no raw stream.
      if (!result.ok) return {
        ...result, final: null, reason: null, events: [], stdout: "", stderr: "",
        error: "使用临时配置的 dsh 任务失败，原始输出已隐藏。",
      };
      return result;
    });
  }
  return runTurn({ bin, env, prompt, cwd, threadId, onEvent, timeoutMs });
}

function runTurn({ bin, env, prompt, cwd, threadId, onEvent, timeoutMs, patch }) {
  const args = ["--profile", "headless"];
  if (patch) args.push("--patch", patch);
  args.push("--json");
  if (threadId) args.push("--session-id", threadId);
  args.push("-");
  return new Promise((resolve, reject) => {
    const child = spawnDsh(bin, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // Own process group so a timeout can kill the whole tree.
      detached: Boolean(timeoutMs) && process.platform !== "win32",
    });
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, timeoutMs)
      : null;
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
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const parsed = parseEvents(stdout);
      if (timedOut) parsed.error = `超时：${timeoutMs} 毫秒内没有结束，已终止`;
      const ok = !timedOut && code === 0 && parsed.final !== null && parsed.reason === "completed";
      resolve({ ok, exitCode: code, timedOut, ...parsed, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(Buffer.from(prompt + PREAMBLE, "utf8"));
  });
}
