import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { transcriptRecords } from "./transcript-records.mjs";
import { readHostOwner } from "./host-owner.mjs";
import { resolveWorkspaceRoot } from "./state.mjs";

const identity = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const sources = new Set(["cli", "vscode", "exec", "mcp"]);
const ignoredRecords = new Set(["event_msg", "turn_context", "compacted", "inter_agent_communication",
  "inter_agent_communication_metadata", "token_usage_record", "world_state", "security_risk_score", "retained_context", "realtime_item"]);
const ignoredItems = new Set(["additional_tools", "agent_message", "reasoning", "function_call_output", "custom_tool_call_output",
  "tool_search_call", "tool_search_output", "web_search_call", "image_generation_call", "configuration_update", "compaction", "context_compaction"]);
const contentTypes = new Set(["input_text", "output_text", "input_image", "input_audio"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const unsupported = () => new Error("不支持的 Codex 记录消息格式，未转交任何内容。");
const samePath = (left, right) => process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;

function projectRoot(cwd) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd) || cwd.includes("\0")) throw new Error();
  const real = fs.realpathSync(cwd);
  if (!fs.statSync(real).isDirectory()) throw new Error();
  return fs.realpathSync(resolveWorkspaceRoot(real));
}

export function resolveCodexTranscript(cwd, source, context) {
  let expectedSessionId = null;
  let ownerWorkspaceRoot;
  if (source === undefined) {
    if (typeof context?.sessionId !== "string" || !context.sessionId.trim()) throw new Error("Codex 转交缺少明确的宿主主线程身份，请检查登记或显式指定 --source。");
    expectedSessionId = context.sessionId;
    if (context.transcriptSource !== null && context.transcriptSource !== undefined) source = context.transcriptSource;
    else {
      const owner = readHostOwner(context);
      source = owner.transcriptSource;
      ownerWorkspaceRoot = owner.workspaceRoot ?? null;
    }
  }
  if (typeof source !== "string" || !source.trim()) throw new Error("未登记 Codex 会话记录，请指定 --source <.jsonl 路径>。");
  let workspaceRoot;
  try {
    workspaceRoot = projectRoot(path.resolve(cwd));
    if (ownerWorkspaceRoot !== undefined && !samePath(projectRoot(ownerWorkspaceRoot), workspaceRoot)) throw new Error();
  } catch { throw new Error("Codex 记录来源的登记项目与当前项目不符或无法核实。"); }
  try {
    const requested = path.resolve(cwd, source);
    const sessions = fs.realpathSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions"));
    const real = fs.realpathSync(requested);
    const relative = path.relative(sessions, real);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
      path.extname(requested).toLowerCase() !== ".jsonl" || path.extname(real).toLowerCase() !== ".jsonl" || !fs.statSync(real).isFile()) throw new Error();
    return { source: real, expectedSessionId, workspaceRoot };
  } catch {
    throw new Error("只接受 CODEX_HOME/sessions 下已存在的普通 .jsonl 会话记录；不允许链接逃逸。");
  }
}

export async function* codexMessages(source, { expectedSessionId, workspaceRoot }) {
  let metadata;
  let supportedMessage = false;
  for await (const record of transcriptRecords(source, "Codex")) {
    if (!object(record)) throw unsupported();
    const item = record?.payload;
    if (!metadata) {
      if (record?.type !== "session_meta" || !item || !identity.test(item.id) ||
        !sources.has(item.source) || (item.parent_thread_id !== undefined && item.parent_thread_id !== null) ||
        (Object.hasOwn(item, "session_id") && item.session_id !== item.id)) {
        throw new Error("不支持的 Codex 记录格式或非主线程身份，未转交任何内容。");
      }
      if (expectedSessionId !== null && item.id !== expectedSessionId) throw new Error("Codex 记录编号与明确的宿主会话身份不符。");
      try { if (!samePath(projectRoot(item.cwd), workspaceRoot)) throw new Error(); }
      catch { throw new Error("Codex 记录与当前项目不符或项目根无法核实。"); }
      metadata = item;
      continue;
    }
    // 后续 metadata 可能来自 fork 的父历史；只有首条属于所选文件身份。
    if (record?.type === "session_meta") continue;
    if (ignoredRecords.has(record.type)) continue;
    if (record.type !== "response_item" || !object(item)) throw unsupported();
    if (ignoredItems.has(item.type)) continue;
    if (["function_call", "custom_tool_call", "local_shell_call"].includes(item.type)) {
      yield { tools: [{ name: item.type === "local_shell_call" ? "local_shell" : item.name }] };
      continue;
    }
    if (item.type !== "message" || !["user", "assistant", "system", "developer"].includes(item.role)) throw unsupported();
    if (["system", "developer"].includes(item.role)) continue;
    if (!Array.isArray(item.content) || item.content.some(part => !object(part) || !contentTypes.has(part.type) ||
      (["input_text", "output_text"].includes(part.type) && typeof part.text !== "string"))) throw unsupported();
    supportedMessage = true;
    // 当前已核实 schema 没有 channel；不把未知 channel 或缺失 phase 当最终回复。
    if (item.channel != null || (item.role === "assistant" && item.phase !== "final_answer")) continue;
    const type = item.role === "user" ? "input_text" : "output_text";
    const text = item.content.filter(part => part.type === type).map(part => part.text).join("\n");
    yield { role: item.role, text };
  }
  if (!metadata) throw new Error("不支持的 Codex 记录格式：缺少首条会话身份。");
  if (!supportedMessage) throw new Error("不支持的 Codex 记录消息格式：需要 response_item 用户或助手文字，不能使用 event-only 记录。");
}
