#!/usr/bin/env node
import { hostContext, sharedDataRoot } from "./lib/host-context.mjs";
import { prepareSharedProject } from "./lib/shared-data.mjs";
import { parseArgs, splitRawArgs } from "./lib/args.mjs";
import { runCompanion } from "./deepseek-companion.mjs";
import { runSession } from "./deepseek-session.mjs";

async function main() {
  const [host, ...raw] = process.argv.slice(2);
  const argv = splitRawArgs(raw);
  const identity = {};
  while (["--session-id", "--transcript-source"].includes(argv[0])) {
    const name = argv.shift();
    const value = argv.shift();
    if (!value?.trim() || value.startsWith("--")) throw new Error(`${name} 必须提供非空值。`);
    identity[name === "--session-id" ? "sessionId" : "transcriptSource"] = value;
  }
  const { flags } = parseArgs(argv, ["cwd"]);
  const context = hostContext(host, flags.cwd || process.cwd(), host === "claude" ? {
    sessionId: process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID,
    transcriptSource: process.env.CLAUDE_TRANSCRIPT_PATH,
    ...identity,
  } : identity);
  process.env.DEEPSEEK_DATA_DIR = sharedDataRoot();
  if (argv[0] === "session") {
    if (host !== "claude") throw new Error("当前会话钩子只接受 Claude 宿主。");
    try { await runSession(argv.slice(1)); }
    catch { throw new Error("Claude 会话钩子失败，未完成登记或清理。"); }
    return;
  }
  if (argv[0] !== "setup") {
    await prepareSharedProject(process.env.DEEPSEEK_DATA_DIR, context.workspaceRoot);
  }
  await runCompanion(argv, { hostContext: context });
}

main().catch((err) => {
  process.stderr.write(`DeepSeek 宿主入口失败：${err.message}\n`);
  process.exitCode = 1;
});
