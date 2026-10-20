#!/usr/bin/env node
import { spawnDsh } from "./lib/dsh.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { windowsJobGuard } from "./lib/windows-job-guard.mjs";
import { posixProcessIdentity, cleanPosixDescendants } from "./lib/posix-process.mjs";

// 独立宿主持有真实 dsh 的管道；worker 退出不会把 EPIPE 传给 dsh。
// 宿主命令行中的作业标识用于恢复时验证 PID 归属，不转发给 dsh。
function forward(source, target) {
  target.on("error", () => {});
  source.on("data", (chunk) => { if (!target.destroyed) target.write(chunk); });
}

// worker 先原子保存宿主 PID，再发送任务正文。未收到正文就失去 worker
// 时不启动 dsh，避免“已 spawn 宿主、尚未持久化 PID”的崩溃窗口。
export async function runDshHost(bin, args, { input = process.stdin, output = process.stdout, error = process.stderr, beforeStart, onExited } = {}) {
  const chunks = [];
  try { for await (const chunk of input) chunks.push(Buffer.from(chunk)); }
  catch { return 1; }
  const prompt = Buffer.concat(chunks);
  if (!prompt.length) return 1;
  await beforeStart?.();
  return new Promise((resolve, reject) => {
    try {
      const child = spawnDsh(bin, args, {
        cwd: process.cwd(), env: process.env, windowsHide: true, detached: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      forward(child.stdout, output);
      forward(child.stderr, error);
      child.stdin.on("error", () => {});
      child.on("error", () => { if (!error.destroyed) error.write("启动 dsh 失败。\n"); resolve(1); });
      let cleanup = Promise.resolve();
      child.on("exit", () => {
        cleanup = Promise.resolve().then(() => onExited?.());
        cleanup.catch(reject);
      });
      child.on("close", (code) => { cleanup.then(() => resolve(code ?? 1), reject); });
      child.stdin.end(prompt);
    } catch {
      if (!error.destroyed) error.write("启动 dsh 失败。\n");
      resolve(1);
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [owner, bin, ...args] = process.argv.slice(2);
  let exitCode = 2;
  let guard;
  if (/^--deepseek-owner=[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(owner ?? "") && bin) {
    const token = owner.slice("--deepseek-owner=".length);
    try {
      exitCode = await runDshHost(bin, args, {
        beforeStart: async () => {
          guard = process.platform === "win32"
            ? await windowsJobGuard({ script: fileURLToPath(import.meta.url), token })
            : { clean: () => cleanPosixDescendants(posixProcessIdentity(process.pid, token)) };
        },
        onExited: () => guard.clean(),
      });
    } catch { exitCode = 1; }
  }
  if (typeof process.send === "function" && guard) {
    // 宿主保留归属入口，排空输出后再通知 worker 用 killTree 结束宿主与整个组。
    await Promise.all([process.stdout, process.stderr].map((stream) => new Promise((resolve) => {
      if (stream.destroyed || stream.writableEnded) resolve();
      else stream.write("", resolve);
    })));
    setInterval(() => {}, 1000);
    try { if (process.connected) process.send({ type: "deepseek-dsh-exit", exitCode }, () => {}); }
    catch { /* worker 已退出，保持宿主存活等待 status/cancel 清理。 */ }
  } else process.exitCode = exitCode;
}
