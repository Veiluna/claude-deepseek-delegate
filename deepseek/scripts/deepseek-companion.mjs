#!/usr/bin/env node
import process from "node:process";
import { parseArgs, splitRawArgs } from "./lib/args.mjs";
import { resolveWorkspaceRoot } from "./lib/state.mjs";
import { runDsh, DshNotFoundError } from "./lib/dsh.mjs";

function out(text) {
  process.stdout.write(text.endsWith("\n") ? text : text + "\n");
}

function fail(text, code = 1) {
  process.stderr.write(text.endsWith("\n") ? text : text + "\n");
  process.exit(code);
}

function describeFailure(r) {
  const lines = ["DeepSeek 任务失败。"];
  lines.push(`退出码：${r.exitCode}`);
  if (r.error) lines.push(`错误：${r.error}`);
  if (r.final === null) lines.push("没有收到最终回复（final）。");
  else if (r.reason !== "completed") lines.push(`结束原因：${r.reason ?? "未知"}（期望 completed）`);
  if (r.stderr.trim()) lines.push("", "--- stderr ---", r.stderr.trim());
  if (r.stdout.trim()) lines.push("", "--- 原始输出 ---", r.stdout.trim());
  return lines.join("\n");
}

async function cmdTask(argv) {
  const { flags, text } = parseArgs(argv, ["cwd"]);
  if (!text) fail("用法：task [--read-only] [--cwd <目录>] [--json] <任务描述>", 2);
  const workspaceRoot = resolveWorkspaceRoot(flags.cwd || process.cwd());
  const permissionMode = flags["read-only"] ? "read-only" : "workspace-write";
  let r;
  try {
    r = await runDsh({ prompt: text, cwd: workspaceRoot, permissionMode });
  } catch (err) {
    if (err instanceof DshNotFoundError) {
      fail(`${err.message}\n请安装 DeepSeek Harness 或设置 DSH_BIN，然后运行 /deepseek:setup 检查环境。`);
    }
    fail(`启动 dsh 失败：${err.message}\n请运行 /deepseek:setup 检查环境。`);
  }
  if (flags.json) {
    out(JSON.stringify({
      ok: r.ok,
      threadId: r.threadId,
      final: r.final,
      reason: r.reason,
      exitCode: r.exitCode,
      error: r.error,
      ...(r.ok ? {} : { stdout: r.stdout, stderr: r.stderr }),
    }, null, 2));
    process.exit(r.ok ? 0 : 1);
  }
  if (!r.ok) fail(describeFailure(r));
  out(r.final);
}

const COMMANDS = { task: cmdTask };

async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  const handler = COMMANDS[sub];
  if (!handler) fail(`未知子命令：${sub ?? "(空)"}。可用：${Object.keys(COMMANDS).join("、")}`, 2);
  await handler(splitRawArgs(rest));
}

main();
