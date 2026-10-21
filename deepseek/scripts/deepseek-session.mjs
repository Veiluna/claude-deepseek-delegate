#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dataRoot, resolveWorkspaceRoot } from "./lib/state.mjs";
import { cleanSessionJobs, cleanHostSessionJobs } from "./lib/jobs.mjs";
import { hostContext } from "./lib/host-context.mjs";
import { registerHostSession, captureOwnerSnapshot, validateSnapshot } from "./lib/host-owner.mjs";

const shellQuote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const text = (value) => typeof value === "string" && value.length > 0 && !value.includes("\0");

export async function runSession(argv = process.argv.slice(2), { host } = {}) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("无效的会话钩子 JSON。"); }
  if (host) {
    if (input?.hook_event_name === "SessionEnd") {
      if (!text(input.session_id) || !text(input.cwd) || !path.isAbsolute(input.cwd)) throw new Error("无效的宿主会话结束输入。");
      if (argv[0] === "--cleanup") {
        const snapshot = validateSnapshot(input.snapshot);
        if (snapshot.host !== host || snapshot.sessionId !== input.session_id) throw new Error("清理围栏与宿主会话身份不符。");
        await cleanHostSessionJobs(snapshot, { before: input.before });
        return;
      }
      // 只读已原子发布的登记快照，不等锁、不解析项目、不枚举作业、不查进程。
      const before = Date.now();
      const snapshot = captureOwnerSnapshot({ host, sessionId: input.session_id });
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--host", host, "--cleanup"], {
        cwd: input.cwd, detached: true, windowsHide: true, stdio: ["pipe", "ignore", "ignore"],
      });
      await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.stdin.on("error", reject);
        child.once("spawn", () => child.stdin.end(JSON.stringify({ hook_event_name: "SessionEnd", session_id: input.session_id,
          cwd: input.cwd, before, snapshot }), resolve));
      });
      child.unref();
      return;
    }
    if (input?.hook_event_name !== "SessionStart" || !text(input.session_id) || !text(input.cwd) || !path.isAbsolute(input.cwd) ||
      !(input.transcript_path === null || text(input.transcript_path))) throw new Error("无效的宿主 SessionStart 登记输入。");
    if (host === "claude") {
      if (!text(process.env.CLAUDE_ENV_FILE)) throw new Error("缺少 Claude 会话登记环境文件。");
      fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `\nexport CLAUDE_SESSION_ID=${shellQuote(input.session_id)}\nexport CLAUDE_TRANSCRIPT_PATH=${shellQuote(input.transcript_path || "")}\n`);
    }
    await registerHostSession(hostContext(host, input.cwd, { sessionId: input.session_id, transcriptSource: input.transcript_path }));
    return;
  }
  if (!text(input?.session_id)) throw new Error("无效的 Claude 会话编号。");
  if (input.hook_event_name === "SessionEnd") {
    const before = Date.now();
    if (!text(input.cwd) || !path.isAbsolute(input.cwd)) throw new Error("无效的项目目录。");
    if (process.env.DEEPSEEK_DATA_DIR && !fs.existsSync(dataRoot())) return;
    const root = resolveWorkspaceRoot(input.cwd);
    if (argv[0] === "--cleanup") {
      if (!Number.isFinite(input.before)) throw new Error("无效的清理时刻。");
      await cleanSessionJobs(root, input.session_id, { before: input.before });
    } else {
      // 插件 SessionEnd 的总预算默认只有 1.5 秒，不能用插件 timeout 延长。
      // 独立进程完成清理，关闭输入后不保留父进程的终端或输出管道。
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--cleanup"], {
        cwd: root, detached: true, windowsHide: true, stdio: ["pipe", "ignore", "ignore"],
      });
      await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.stdin.on("error", reject);
        child.once("spawn", () => child.stdin.end(JSON.stringify({ hook_event_name: "SessionEnd", session_id: input.session_id, cwd: root, before }), resolve));
      });
      child.unref();
    }
    return;
  }
  if (input.hook_event_name !== "SessionStart" || !text(input.transcript_path) || !text(process.env.CLAUDE_ENV_FILE)) {
    throw new Error("无效的 Claude 会话登记输入。");
  }
  // 只追加环境赋值，不读取会话记录、不输出上下文或分派规则（ADR-0002）。
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `\nexport CLAUDE_SESSION_ID=${shellQuote(input.session_id)}\nexport CLAUDE_TRANSCRIPT_PATH=${shellQuote(input.transcript_path)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  const host = args[0] === "--host" ? args[1] : undefined;
  runSession(host ? args.slice(2) : args, { host }).catch(() => {
    process.stderr.write(`${host ? "宿主" : "Claude "}会话钩子失败，未完成登记或清理。\n`);
    process.exitCode = 1;
  });
}
