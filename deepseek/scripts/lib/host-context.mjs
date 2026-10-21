import os from "node:os";
import path from "node:path";
import { resolveWorkspaceRoot } from "./state.mjs";

const text = (value) => typeof value === "string" && value.trim() && !value.includes("\0") ? value : null;

// 宿主选择来自入口参数；绝不使用另一个宿主的偶然继承变量推断身份。
export function hostContext(host, cwd, { sessionId, transcriptSource } = {}) {
  if (!["claude", "codex", null].includes(host)) throw new Error("无效的宿主种类。");
  return { host, sessionId: text(sessionId), workspaceRoot: resolveWorkspaceRoot(cwd), transcriptSource: text(transcriptSource) };
}

export function sharedDataRoot() {
  return path.resolve(process.env.DEEPSEEK_DATA_DIR || path.join(os.homedir(), ".deepseek-plugin"));
}
