import fs from "node:fs";
import { runDsh } from "./dsh.mjs";

const schema = JSON.parse(fs.readFileSync(new URL("../../schemas/review-output.schema.json", import.meta.url), "utf8"));
const template = fs.readFileSync(new URL("../../prompts/review.md", import.meta.url), "utf8");
const adversarial = fs.readFileSync(new URL("../../prompts/adversarial-review.md", import.meta.url), "utf8");

export function reviewPrompt(context, { kind, focus = "" } = {}) {
  return `${template}\n${kind === "adversarial-review" ? adversarial : ""}\n附加关注点：${JSON.stringify(focus)}\n结果 schema：\n${JSON.stringify(schema)}\n审阅范围：${context.scope}\n基准：${context.baseRef ?? "无"}\n` +
    `git 状态：\n${JSON.stringify(context.status)}\n变更文件：\n${JSON.stringify(context.files)}\n\n${context.content}`;
}

// 仅校验此 schema 使用的约束；不补默认值、不把未知字段伪造成有效结果。
function valid(value, rule) {
  if (rule.enum && !rule.enum.includes(value)) return false;
  if (rule.type === "object") return value !== null && typeof value === "object" && !Array.isArray(value) &&
    rule.required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => Object.hasOwn(rule.properties, key) && valid(value[key], rule.properties[key]));
  if (rule.type === "array") return Array.isArray(value) && value.every((item) => valid(item, rule.items));
  if (rule.type === "string") return typeof value === "string" && [...value].length >= (rule.minLength ?? 0);
  if (rule.type === "integer" || rule.type === "number") return typeof value === "number" && Number.isFinite(value) &&
    (rule.type !== "integer" || Number.isInteger(value)) && value >= (rule.minimum ?? -Infinity) && value <= (rule.maximum ?? Infinity);
  return false;
}

export async function executeReview(options) {
  const result = await runDsh({ ...options, permissionMode: "read-only", threadId: undefined });
  if (!result.ok) return { ...result, review: null };
  try {
    const text = result.final.trim();
    const fenced = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
    const parsed = JSON.parse(fenced ? fenced[1] : text);
    if (!valid(parsed, schema)) throw new Error();
    return { ...result, review: parsed };
  } catch {
    return { ...result, ok: false, review: null, error: "审阅结果不是符合 schema 的 JSON，已保留原始最终回复。" };
  }
}

export function renderReview(result) {
  if (!result.ok) return ["DeepSeek 审阅失败。", result.error || "dsh 未成功完成审阅。",
    ...(result.final != null ? ["--- 原始最终回复 ---", result.final] : []),
    ...(result.stderr ? ["--- stderr ---", result.stderr] : [])].join("\n");
  const data = result.review;
  return [`结论：${data.verdict}`, `摘要：${data.summary}`, "", "问题清单：",
    ...(data.findings.length ? data.findings.map((item) => `[${item.severity}] ${item.title}\n${item.file}:${item.line_start}-${item.line_end}（置信度 ${item.confidence}）\n${item.body}\n建议：${item.recommendation}`) : ["没有发现需要处理的问题。"]),
    "", "后续步骤：", ...data.next_steps.map((step) => `- ${step}`)].join("\n");
}
