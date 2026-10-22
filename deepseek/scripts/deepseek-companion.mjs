#!/usr/bin/env node
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs, splitRawArgs, readPrompt } from "./lib/args.mjs";
import { resolveWorkspaceRoot, loadState } from "./lib/state.mjs";
import { runDsh, findDsh, dshVersion, DshNotFoundError } from "./lib/dsh.mjs";
import { executeTask } from "./lib/task.mjs";
import { startJob, jobStatus, jobStatuses, jobResult, cancelJob } from "./lib/jobs.mjs";
import { collectReviewContext } from "./lib/review-git.mjs";
import { executeReview, reviewPrompt, renderReview } from "./lib/review.mjs";
import { resolveTranscript, transferSession } from "./lib/transfer.mjs";
import { dataRoot } from "./lib/state.mjs";
import { migrateData } from "./lib/migration.mjs";

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

function validateOverrides(flags) {
  if ("model" in flags && (typeof flags.model !== "string" || !flags.model.trim() || flags.model.startsWith("--"))) {
    fail("--model <模型名> 必须提供非空模型名。", 2);
  }
  if ("effort" in flags && !["off", "low", "high", "max"].includes(flags.effort)) {
    fail("--effort 只允许 off、low、high、max。", 2);
  }
}

async function cmdTask(argv, hostContext) {
  const parsed = parseArgs(argv, ["cwd", "expected-thread-id", "model", "effort"]);
  const { flags } = parsed;
  validateOverrides(flags);
  if (flags.resume && flags.fresh) fail("--resume 与 --fresh 不能同时指定。", 2);
  const expectedThreadId = flags["expected-thread-id"];
  if ("expected-thread-id" in flags && (!flags.resume || typeof expectedThreadId !== "string" || !expectedThreadId.trim() || expectedThreadId.startsWith("--"))) {
    fail("--expected-thread-id <线程ID> 必须与 --resume 配合，并提供非空线程 ID。", 2);
  }
  let text;
  try { text = readPrompt(parsed); }
  catch (err) { fail(err.message, 2); }
  if (!text) fail("用法：task [--background] [--resume [--expected-thread-id <线程ID>] | --fresh] [--model <模型名>] [--effort <off|low|high|max>] [--read-only] [--cwd <目录>] [--json] [--prompt-stdin | <任务描述>]", 2);
  const workspaceRoot = resolveWorkspaceRoot(flags.cwd || process.cwd());
  const permissionMode = flags["read-only"] ? "read-only" : "workspace-write";
  const threadId = flags.resume ? loadState(workspaceRoot).resumableThread?.threadId : undefined;
  if (flags.resume && !threadId) fail("当前项目没有可续接线程。请用 --fresh 新开 DeepSeek 线程。");
  if (expectedThreadId !== undefined && threadId !== expectedThreadId) {
    fail("可续接线程已变化，未启动 DeepSeek。请重新运行 /deepseek:task 查看摘要并选择。");
  }
  let r;
  try {
    const options = { prompt: text, cwd: workspaceRoot, permissionMode, threadId, model: flags.model, effort: flags.effort };
    if (flags.background) {
      const job = await startJob(workspaceRoot, options, { hostContext });
      out(flags.json ? JSON.stringify(job, null, 2) : `作业编号：${job.id}\n状态：排队（queued）`);
      return;
    }
    r = await executeTask(options);
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
      ...(r.warnings ? { resumableThreadSaved: false, warnings: r.warnings } : {}),
      ...(r.ok ? {} : { stdout: r.stdout, stderr: r.stderr }),
    }, null, 2));
    process.exitCode = r.ok ? 0 : 1;
    return;
  }
  if (!r.ok) fail(describeFailure(r));
  out(r.final);
}

function cmdTaskResumeCandidate(argv) {
  const { flags } = parseArgs(argv, ["cwd"]);
  const workspaceRoot = resolveWorkspaceRoot(flags.cwd || process.cwd());
  const candidate = loadState(workspaceRoot).resumableThread;
  const result = {
    available: Boolean(candidate?.threadId),
    threadId: candidate?.threadId ?? null,
    summary: candidate?.summary ?? null,
  };
  out(flags.json ? JSON.stringify(result, null, 2) : result.available
    ? `可续接线程：${result.threadId}\n上次任务摘要：${result.summary}`
    : "当前项目没有可续接线程。");
}

const MIN_NODE_MAJOR = 18;
const SETUP_TIMEOUT_MS = 120000;

// Heuristic: dsh's exact wording for a missing login is not documented.
function looksLikeLoginFailure(text) {
  return /not logged in|log ?in|unauthori[sz]ed|authenticat|\b401\b|登录|认证/i.test(text);
}

async function cmdSetup(argv, context) {
  const { flags, positional } = parseArgs(argv, ["migrate-from"]);
  if ("migrate-from" in flags) {
    if (typeof flags["migrate-from"] !== "string" || !flags["migrate-from"].trim() || flags["migrate-from"].startsWith("--") || positional.length ||
      Object.keys(flags).some((name) => !["migrate-from", "json"].includes(name))) throw new Error("迁移只接受 --migrate-from <旧数据根> 和 --json。");
    const migration = await migrateData(flags["migrate-from"], dataRoot());
    out(flags.json ? JSON.stringify({ migration }, null, 2) : `迁移完成：${migration.projects} 个项目，${migration.jobs} 个作业；源目录已保留。`);
    return;
  }
  const nodeOk = Number(process.versions.node.split(".")[0]) >= MIN_NODE_MAJOR;
  const report = {
    ready: false,
    node: { version: process.version, ok: nodeOk },
    dsh: { found: false, path: null, version: null, error: null },
    minimalTask: null,
    suggestions: [],
    ...(context ? { hostContext: context } : {}),
    data: { root: process.env.DEEPSEEK_DATA_DIR || dataRoot(), projects: dataRoot(), legacySource: process.env.CLAUDE_PLUGIN_DATA || null },
  };
  if (!nodeOk) report.suggestions.push(`升级 Node 到 ${MIN_NODE_MAJOR} 或更高版本。`);
  try {
    const bin = findDsh();
    report.dsh = { found: true, path: bin, version: dshVersion(bin), error: null };
  } catch (err) {
    if (!(err instanceof DshNotFoundError)) throw err;
    report.dsh.error = err.message;
    report.suggestions.push(
      err.reason === "bad-dsh-bin"
        ? "检查 DSH_BIN：把它改成 dsh 的完整路径（Windows 上通常是 dsh.cmd），或删掉它让插件自动查找。"
        : "安装 DeepSeek Harness；如果已经安装，把环境变量 DSH_BIN 设为 dsh 的完整路径（Windows 上通常是 dsh.cmd）。",
    );
  }
  if (report.dsh.found) {
    let r;
    try {
      r = await runDsh({
        prompt: "这是一次连通性检查。请只回复 OK，不要读取或修改任何文件。",
        cwd: resolveWorkspaceRoot(process.cwd()),
        permissionMode: "read-only",
        timeoutMs: Number(process.env.DEEPSEEK_SETUP_TIMEOUT_MS) || SETUP_TIMEOUT_MS,
      });
    } catch (err) {
      r = { ok: false, final: null, error: `启动 dsh 失败：${err.message}`, reason: null, exitCode: null, stdout: "", stderr: "" };
    }
    report.minimalTask = { ok: r.ok, reply: r.final, error: r.error, reason: r.reason, exitCode: r.exitCode };
    if (!r.ok) {
      report.minimalTask.output = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join("\n");
      if (looksLikeLoginFailure([r.error, r.stderr].filter(Boolean).join("\n"))) {
        report.suggestions.push("在 DeepSeek Harness 中登录（或在终端运行 dsh 完成登录），然后重新运行 /deepseek:setup。");
      } else {
        report.suggestions.push("最小任务没有成功完成。先在终端直接运行 dsh 确认它能正常对话，再根据上面的原始输出排查。");
      }
    }
  }
  report.ready = nodeOk && report.dsh.found && report.minimalTask?.ok === true;
  out(flags.json ? JSON.stringify(report, null, 2) : renderSetup(report));
}

function renderSetup(report) {
  const lines = [`Node：${report.node.version}${report.node.ok ? "" : `（需要 ${MIN_NODE_MAJOR} 或更高）`}`];
  lines.push(`数据根：${report.data.root}`, `项目数据：${report.data.projects}`);
  if (report.data.legacySource && report.data.legacySource !== report.data.root) {
    lines.push(`旧插件目录（仅提示，未迁移）：${report.data.legacySource}`);
  }
  if (report.dsh.found) {
    lines.push(`dsh：${report.dsh.path}（${report.dsh.version ?? "版本未知"}）`);
  } else {
    lines.push(`dsh：未找到。${report.dsh.error}`);
  }
  if (report.minimalTask === null) {
    lines.push("最小任务：未运行（找不到 dsh）");
  } else if (report.minimalTask.ok) {
    lines.push("最小任务：通过");
  } else {
    lines.push(`最小任务：失败。${report.minimalTask.error ?? `结束原因 ${report.minimalTask.reason ?? "未知"}，退出码 ${report.minimalTask.exitCode}`}`);
    if (report.minimalTask.output) lines.push("", "--- 原始输出 ---", report.minimalTask.output, "");
  }
  lines.push("", report.ready ? "可以使用 /deepseek:task。" : "还不能使用，请先处理下面的问题。");
  if (report.suggestions.length) {
    lines.push("", "建议：", ...report.suggestions.map((x) => `- ${x}`));
  }
  return lines.join("\n");
}

const statusNames = { queued: "排队", running: "运行", completed: "完成", failed: "失败", cancelled: "已取消" };
async function cmdJob(command, argv, hostContext) {
  const { flags, positional } = parseArgs(argv, ["cwd", "timeout-ms"]);
  if (positional.length > 1) fail("只能指定一个作业编号。", 2);
  if ("timeout-ms" in flags && (!flags.wait || !/^\d+$/.test(flags["timeout-ms"] ?? "") || !Number.isSafeInteger(Number(flags["timeout-ms"])))) {
    fail("--timeout-ms 必须与 --wait 配合，值为非负整数。", 2);
  }
  const root = resolveWorkspaceRoot(flags.cwd || process.cwd());
  const id = positional[0];
  const statusOptions = { hostContext, wait: Boolean(flags.wait), all: Boolean(flags.all), timeoutMs: flags["timeout-ms"] === undefined ? undefined : Number(flags["timeout-ms"]) };
  const result = command === "status" ? await (id ? jobStatus(root, id, statusOptions) : jobStatuses(root, statusOptions))
    : command === "result" ? await jobResult(root, id, { hostContext }) : await cancelJob(root, id, { hostContext });
  if (flags.json) out(JSON.stringify(result, null, 2));
  else if (command === "result") {
    if (["review", "adversarial-review"].includes(result.kind)) out(renderReview(result));
    else if (result.ok) out(result.final);
    else out(`作业：${result.id}\n状态：${statusNames[result.status]}\n${result.error || "DeepSeek 任务失败。"}`);
  } else {
    const jobs = Array.isArray(result) ? result : [result];
    out(jobs.length ? jobs.map((job) => [
      `作业：${job.id}`, `种类：${job.kind}`, `状态：${statusNames[job.status]}（${job.status}）`,
      ...(command === "status" ? [`耗时：${job.elapsedMs} 毫秒`, ...(job.timedOut ? ["等待超时，作业继续运行。"] : []), ...job.progress] : []),
    ].join("\n")).join("\n\n") : hostContext ? "当前宿主会话没有作业。" : "当前 Claude 会话没有作业。");
  }
}

async function cmdReview(argv, kind, hostContext) {
  const parsed = parseArgs(argv, ["cwd", "scope", "base", "model", "effort"]);
  const { flags } = parsed;
  let text;
  try { text = readPrompt(parsed); }
  catch (err) { fail(err.message, 2); }
  validateOverrides(flags);
  for (const name of ["cwd", "scope", "base"]) {
    if (name in flags && (typeof flags[name] !== "string" || !flags[name].trim() || flags[name].startsWith("--"))) {
      fail(`--${name} 必须提供非空值。`, 2);
    }
  }
  if (kind === "review" && text) fail("普通审阅不接收附加关注点，请用 adversarial-review。", 2);
  const context = collectReviewContext(flags.cwd || process.cwd(), { scope: flags.scope, base: flags.base });
  if (kind === "review-context") {
    out(JSON.stringify({ scope: context.scope, baseRef: context.baseRef, fileCount: context.files.length,
      diffBytes: context.diffBytes, empty: !context.files.length,
      suggestedMode: context.files.length <= 2 && context.diffBytes <= 64 * 1024 ? "foreground" : "background" }, null, 2));
    return;
  }
  if (!context.files.length) {
    const message = "没有可审阅的变更。";
    out(flags.json ? JSON.stringify({ ok: true, empty: true, ...context, message }, null, 2) : message);
    return;
  }
  const options = { kind, prompt: reviewPrompt(context, { kind, focus: text }), cwd: context.root, model: flags.model, effort: flags.effort };
  if (flags.background) {
    const job = await startJob(context.root, options, { hostContext });
    out(flags.json ? JSON.stringify(job, null, 2) : `作业编号：${job.id}\n种类：${kind}\n状态：排队（queued）`);
    return;
  }
  const result = await executeReview(options);
  const { events, stdout, stderr, timedOut, ...output } = result;
  out(flags.json ? JSON.stringify({ ...output, ...(!result.ok ? { stdout, stderr } : {}) }, null, 2) : renderReview(result));
  process.exitCode = result.ok ? 0 : 1;
}

async function cmdTransfer(argv) {
  const { flags, positional } = parseArgs(argv, ["cwd", "source", "max-chars"]);
  if (positional.length || Object.keys(flags).some((name) => !["cwd", "source", "max-chars", "json"].includes(name))) {
    fail("转交只接受 --source、--cwd、--max-chars、--json。", 2);
  }
  for (const name of ["source", "cwd"]) {
    if (name in flags && (typeof flags[name] !== "string" || !flags[name].trim() || flags[name].startsWith("--"))) fail(`--${name} 必须提供有效路径。`, 2);
  }
  if ("max-chars" in flags && (!/^\d+$/.test(flags["max-chars"] ?? "") || Number(flags["max-chars"]) < 512 || Number(flags["max-chars"]) > 64000)) {
    fail("--max-chars 必须为 512 到 64000 的整数。", 2);
  }
  const cwd = flags.cwd || process.cwd();
  const source = resolveTranscript(cwd, flags.source);
  const result = await transferSession({ cwd: resolveWorkspaceRoot(cwd), source, maxChars: flags["max-chars"] === undefined ? undefined : Number(flags["max-chars"]) });
  out(flags.json ? JSON.stringify(result, null, 2) : result.ok ?
    `DeepSeek 线程：${result.threadId}\n续接命令：${result.resumeCommand}\n${result.harnessInstructions}` +
      (result.omittedTools || result.compressedMessages ? `\n长度预算：省略 ${result.omittedTools} 条旧工具概况，压缩 ${result.compressedMessages} 段早期文字。` : "") : result.error);
  process.exitCode = result.ok ? 0 : 1;
}

const COMMANDS = { task: cmdTask, "task-resume-candidate": cmdTaskResumeCandidate, setup: cmdSetup, transfer: cmdTransfer,
  review: (argv, context) => cmdReview(argv, "review", context), "adversarial-review": (argv, context) => cmdReview(argv, "adversarial-review", context),
  "review-context": (argv) => cmdReview(argv, "review-context"),
  status: (argv, context) => cmdJob("status", argv, context), result: (argv, context) => cmdJob("result", argv, context), cancel: (argv, context) => cmdJob("cancel", argv, context),
};

export async function runCompanion(argv, { hostContext } = {}) {
  const [sub, ...rest] = argv;
  const handler = COMMANDS[sub];
  if (!handler) fail(`未知子命令：${sub ?? "(空)"}。可用：${Object.keys(COMMANDS).join("、")}`, 2);
  await handler(splitRawArgs(rest), hostContext);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) runCompanion(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`DeepSeek 命令失败：${err.message}\n`);
  process.exitCode = 1;
});
