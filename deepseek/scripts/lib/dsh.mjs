import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildPatches, withPatch } from "./config-patch.mjs";
import { killWindowsProcessTree } from "./windows-process.mjs";
import { randomUUID } from "node:crypto";
import { posixProcessIdentity, killPosixProcessTree, OWNER_ENV } from "./posix-process.mjs";

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

export function spawnDsh(bin, args, options, ownerToken) {
  if (ownerToken) {
    const script = fileURLToPath(new URL("../deepseek-dsh-host.mjs", import.meta.url));
    const child = spawn(process.execPath, [script, `--deepseek-owner=${ownerToken}`, bin, ...args], {
      ...options, detached: true, windowsHide: true,
      stdio: [...options.stdio, "ipc"],
    });
    if (process.platform === "win32") child.deepseekIdentity = { script, token: ownerToken };
    child.deepseekManaged = true;
    child.deepseekControl = true;
    return child;
  }
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

export function killTree(child) {
  if (!Number.isInteger(child.pid) || child.pid <= 0) return;
  if (process.platform === "win32") {
    if (child.identity || child.deepseekIdentity) {
      return killWindowsProcessTree(child.pid, child.identity || child.deepseekIdentity);
    }
    const r = spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true, stdio: "ignore" });
    if (r.error || r.status !== 0) {
      try { process.kill(child.pid, 0); }
      catch (err) { if (err.code === "ESRCH") return; throw err; }
      throw new Error(`无法结束进程树：${child.pid}`);
    }
  } else {
    return killPosixProcessTree(child.pid, child.identity || child.deepseekIdentity);
  }
}

// Run one headless turn. Resolves with { ok, exitCode, threadId, final, reason, error, timedOut, stdout, stderr }.
export async function runDsh({ prompt, cwd, permissionMode, threadId, onEvent, onSpawn, onPatch, processGroup, ownerToken, timeoutMs, model, effort }) {
  const bin = findDsh();
  if (process.platform !== "win32") ownerToken ||= randomUUID();
  const env = { ...process.env, DSH_PERMISSION_MODE: permissionMode, ...(ownerToken ? { [OWNER_ENV]: ownerToken } : {}) };
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
      await onPatch?.(patch);
      const result = await runTurn({ bin, env, prompt, cwd, threadId, onSpawn, processGroup, ownerToken, timeoutMs, patch });
      // dsh may echo config validation errors, including secrets from the patch.
      // Keep ordinary task output unchanged; overridden failures expose no raw stream.
      if (!result.ok) return {
        ...result, final: null, reason: null, events: [], stdout: "", stderr: "",
        error: "使用临时配置的 dsh 任务失败，原始输出已隐藏。",
      };
      return result;
    });
  }
  return runTurn({ bin, env, prompt, cwd, threadId, onEvent, onSpawn, processGroup, ownerToken, timeoutMs });
}

function runTurn({ bin, env, prompt, cwd, threadId, onEvent, onSpawn, processGroup, ownerToken, timeoutMs, patch }) {
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
      detached: (processGroup ?? Boolean(timeoutMs)) && process.platform !== "win32",
    }, ownerToken);
    let spawnFailure;
    let reportedExitCode;
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
      if (spawnFailure) { reject(spawnFailure); return; }
      const hostFailed = child.deepseekControl && reportedExitCode === undefined && !timedOut;
      if (hostFailed) {
        try { killTree(child); }
        catch (err) { err.cleanupPending = true; reject(err); return; }
      }
      const exitCode = reportedExitCode ?? code;
      const parsed = parseEvents(stdout);
      if (timedOut) parsed.error = `超时：${timeoutMs} 毫秒内没有结束，已终止`;
      if (hostFailed) parsed.error = "作业宿主提前退出，未完成进程组清理。";
      const ok = !hostFailed && !timedOut && exitCode === 0 && parsed.final !== null && parsed.reason === "completed";
      resolve({ ok, exitCode, timedOut, ...parsed, stdout, stderr });
    });
    child.on("message", (message) => {
      if (!child.deepseekControl || timedOut || reportedExitCode !== undefined ||
        message?.type !== "deepseek-dsh-exit" || !Number.isInteger(message.exitCode)) return;
      reportedExitCode = message.exitCode;
      try { killTree(child); }
      catch (err) {
        // 宿主继续持有组归属；保留 PID 供下一次 status/cancel 重试清理。
        err.cleanupPending = true;
        if (timer) clearTimeout(timer);
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        if (child.connected) child.disconnect();
        child.unref?.();
        reject(err);
      }
    });
    child.stdin.on("error", () => {});
    child.once("spawn", () => {
      Promise.resolve().then(() => {
        if (process.platform !== "win32") child.deepseekIdentity = posixProcessIdentity(child.pid, ownerToken);
        return onSpawn?.(child.pid, child.deepseekIdentity);
      }).then(() => {
        child.stdin.end(Buffer.from(prompt + PREAMBLE, "utf8"));
      }, (err) => {
        spawnFailure = err;
        // 正文尚未发送；托管宿主收到 EOF 会直接退出，真实 dsh 从未启动。
        child.stdin.destroy();
        if (!child.deepseekManaged) {
          try { killTree(child); }
          catch (cleanupError) { cleanupError.cleanupPending = true; reject(cleanupError); }
        }
      });
    });
  });
}
