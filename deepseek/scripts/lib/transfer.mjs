import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDsh } from "./dsh.mjs";
import { transcriptRecords } from "./transcript-records.mjs";

export function resolveTranscript(cwd, source = process.env.CLAUDE_TRANSCRIPT_PATH) {
  if (typeof source !== "string" || !source.trim()) throw new Error("未登记 Claude 会话记录，请指定 --source <.jsonl 路径>。");
  const requested = path.resolve(cwd, source);
  if (path.extname(requested).toLowerCase() !== ".jsonl") throw new Error("Claude 会话记录必须是 .jsonl 文件。");
  const projectsPath = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
  try {
    const projects = fs.realpathSync(projectsPath);
    const real = fs.realpathSync(requested);
    const relative = path.relative(projects, real);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
      path.extname(real).toLowerCase() !== ".jsonl" || !fs.statSync(real).isFile()) throw new Error();
    return real;
  } catch {
    throw new Error("只接受 Claude 项目目录下已存在的普通 .jsonl 会话记录；不允许链接逃逸。");
  }
}

const titles = ["目标", "已定决策与约束（含不要做的事）", "涉及文件", "验收标准", "输出要求"];
const categories = [
  /^(?:目标|需求|goal|objective)\s*(?:[:：]|$)/i,
  /^(?:已定决策与约束(?:（含不要做的事）)?|已定决策|决策|约束|不要做的事|decisions?|constraints?)\s*(?:[:：]|$)/i,
  /^(?:涉及文件|文件|files?)\s*(?:[:：]|$)/i,
  /^(?:验收标准|验收|acceptance(?: criteria)?)\s*(?:[:：]|$)/i,
  /^(?:输出要求|输出|output(?: requirements)?)\s*(?:[:：]|$)/i,
];

const credentialLabel = String.raw`(?:[\w.-]*(?:api[ \t_-]*key|access[ \t_-]*(?:key|token)|private[ \t_-]*key|client[ \t_-]*secret|secret|token|password|credential)[\w.-]*|密码|密钥|令牌)`;
function redact(text) {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[私钥已隐藏]")
    .replace(new RegExp(String.raw`(^[ \t]*(?:-[ \t]+)?["']?${credentialLabel}["']?[ \t]*:[ \t]*)(?:[|>][-+]?[^\r\n]*)?\r?\n(?:[ \t]+[^\r\n]*(?:\r?\n|$))+`, "gim"), "$1[多行密钥已隐藏]\n")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]+/gi, "$1 [已隐藏]")
    .replace(new RegExp(String.raw`(${credentialLabel}\s*["']?\s*[:=]\s*)(?:"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|[^\s,;；&]+)`, "gi"), "$1[已隐藏]")
    .replace(/\b(?:sk-[\w-]{8,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[\w-]{12,}|AKIA[A-Z0-9]{16})\b/g, "[已隐藏]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[已隐藏]@")
    .replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, (token) => /[A-Za-z]/.test(token) && /\d/.test(token) ? "[已隐藏]" : token);
}

function omitMarkedBodies(text) {
  let hiding = false;
  const kept = [];
  for (const line of text.split(/\r?\n/)) {
    const heading = line.trim().replace(/^#+\s*/, "");
    if (/^(?:文件全文|完整文件内容|file contents|full file|思考过程|thinking|analysis)\s*[:：]/i.test(heading)) {
      hiding = true;
      kept.push("[文件全文或思考区已省略]");
    } else {
      // 区块内的空行仍属于正文，只有明确的交接章节才能重新开始保留文字。
      if (hiding && categories.some((pattern) => pattern.test(heading))) hiding = false;
      if (!hiding) kept.push(line);
    }
  }
  return kept.join("\n");
}

function cleanText(text) {
  return redact(omitMarkedBodies(text
    .replace(/(```|~~~)[\s\S]*?(?:\1|$)/g, "[代码块已省略]")
    .replace(/<(thinking|think|analysis|reasoning|file_contents|file|document|attachment|tool_result|tool_output|system-reminder)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "[思考、文件或工具正文已省略]"))
    .replace(/^(?: {4}|\t).*$/gm, "[缩进代码已省略]")
    .replace(/^\s*\d+\s*[→|].*$/gm, "[文件正文已省略]"));
}

function toolSummary(part) {
  const name = typeof part.name === "string" && /^[A-Za-z][\w:-]{0,79}$/.test(part.name) ? part.name : "其他工具";
  const action = { Read: "请求读取", Write: "请求写入", Edit: "请求修改", MultiEdit: "请求修改" }[name];
  const file = action && typeof part.input?.file_path === "string" ? JSON.stringify(redact(part.input.file_path).slice(0, 300)) : "";
  return `- 工具 ${redact(name)}：${action || "调用"}${file ? ` ${file}` : ""}（结果未核实；参数正文和输出已省略）`;
}

async function* claudeMessages(source) {
  for await (const record of transcriptRecords(source, "Claude")) {
    if (!record || typeof record !== "object" || record.isMeta) continue;
    const role = record.message?.role ?? record.type ?? record.role;
    if (!["user", "assistant"].includes(role) || !["user", "assistant"].includes(record.type ?? record.role)) continue;
    const content = record.message?.content;
    const texts = typeof content === "string" ? [content] : Array.isArray(content) ? content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text) : [];
    yield { role, text: texts.join("\n"), tools: Array.isArray(content) ? content.filter(part => part?.type === "tool_use") : [] };
  }
}

export async function buildHandoff(source, maxChars = 12000, { messages = claudeMessages(source), speaker = "Claude" } = {}) {
  let entries = [];
  for await (const message of messages) {
    for (const part of message.tools || []) entries.push({ section: 2, tool: true, text: toolSummary(part) });
    let section = 0;
    for (const paragraph of cleanText(message.text || "").split(/\r?\n/).map((part) => part.trim()).filter(Boolean)) {
      const heading = paragraph.replace(/^#+\s*/, "");
      const found = categories.findIndex((pattern) => pattern.test(heading));
      if (found >= 0) section = found;
      const author = message.role === "user" ? "用户" : speaker;
      entries.push({ section, tool: false, text: `- ${author}：${paragraph}` });
      if (section === 0) {
        // 保留文字往来，再把明确的约束、验收与输出要求归入对应部分。
        for (const sentence of paragraph.split(/[。！？；]|\.(?=\s)/).filter((part) => part.trim())) {
          for (const [target, pattern] of [
            [1, /不要|禁止|不允许|必须|不能|决定|采用|约束|保持|\b(?:must|never|decided|constraints?)\b|do not/i],
            [3, /验收|npm test|测试.*通过|\bacceptance\b|tests? (?:must )?pass/i],
            [4, /输出|汇报|总结|最终回复|\b(?:output|report|respond)\b/i],
          ]) if (pattern.test(sentence)) entries.push({ section: target, tool: false, text: `- ${author}：${sentence.trim()}` });
        }
      }
    }
  }
  if (!entries.some((entry) => !entry.tool)) throw new Error(`${speaker} 会话记录没有可转交的文字往来。`);
  const render = () => "# 交接说明\n\n" + titles.map((title, index) => `## ${title}\n${entries.filter((entry) => entry.section === index).map((entry) => entry.text).join("\n") || "原记录未明确，请继续前确认。"}`).join("\n\n") +
    "\n\n本次仅转交：请简短确认收到，等待用户继续，不读取或修改文件，不自动执行任务。\n";
  let omittedTools = 0;
  let compressedMessages = 0;
  // 优先删除最旧工具概况，文字往来只有在工具仍不足以腾出预算时才压缩。
  const tools = entries.filter((entry) => entry.tool);
  for (const tool of tools) {
    if (render().length <= maxChars) break;
    entries = entries.filter((entry) => entry !== tool);
    omittedTools++;
  }
  for (const entry of entries) {
    if (render().length <= maxChars) break;
    if (entry.text.length > 140) {
      const head = entry.text.slice(0, 90).replace(/[\uD800-\uDBFF]$/, "");
      const tail = entry.text.slice(-30).replace(/^[\uDC00-\uDFFF]/, "");
      entry.text = head + "…[早期文字已压缩]…" + tail;
      entry.compressed = true;
      compressedMessages++;
    }
  }
  while (render().length > maxChars && entries.length > 1) {
    const oldest = entries.shift();
    if (!oldest.compressed) compressedMessages++;
  }
  return { handoff: render(), omittedTools, compressedMessages };
}

export async function transferSession({ cwd, source, maxChars, messages, speaker }) {
  const payload = await buildHandoff(source, maxChars, { messages, speaker });
  const { handoff } = payload;
  const result = await runDsh({ cwd, prompt: handoff, permissionMode: "read-only" });
  if (!result.ok || typeof result.threadId !== "string" || !/^[\w][\w.:-]*$/.test(result.threadId)) {
    return { ok: false, error: "转交未完成，未取得可续接的 DeepSeek 线程编号。" };
  }
  return { ok: true, threadId: result.threadId, ...payload, resumeCommand: `dsh tui --resume ${result.threadId}`,
    harnessInstructions: `打开 DeepSeek Harness；若工作目录 ${cwd} 尚未登记，请先将其登记为工作区，再在该工作区的线程列表中查找线程 ${result.threadId}，打开后继续。` };
}
