#!/usr/bin/env node
import process from "node:process";
import { parseArgs, splitRawArgs } from "./lib/args.mjs";
import { resolveWorkspaceRoot, loadState } from "./lib/state.mjs";
import { runDsh, findDsh, dshVersion, DshNotFoundError } from "./lib/dsh.mjs";
import { executeTask } from "./lib/task.mjs";
import { startJob, jobStatus, jobStatuses, jobResult, cancelJob } from "./lib/jobs.mjs";

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
  const { flags, text } = parseArgs(argv, ["cwd", "expected-thread-id", "model", "effort"]);
  if ("model" in flags && (typeof flags.model !== "string" || !flags.model.trim() || flags.model.startsWith("--"))) {
    fail("--model <模型名> 必须提供非空模型名。", 2);
  }
  if ("effort" in flags && !["off", "low", "high", "max"].includes(flags.effort)) {
    fail("--effort 只允许 off、low、high、max。", 2);
  }
  if (flags.resume && flags.fresh) fail("--resume 与 --fresh 不能同时指定。", 2);
  const expectedThreadId = flags["expected-thread-id"];
  if ("expected-thread-id" in flags && (!flags.resume || typeof expectedThreadId !== "string" || !expectedThreadId.trim() || expectedThreadId.startsWith("--"))) {
    fail("--expected-thread-id <线程ID> 必须与 --resume 配合，并提供非空线程 ID。", 2);
  }
  if (!text) fail("用法：task [--background] [--resume [--expected-thread-id <线程ID>] | --fresh] [--model <模型名>] [--effort <off|low|high|max>] [--read-only] [--cwd <目录>] [--json] <任务描述>", 2);
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
      const job = await startJob(workspaceRoot, options);
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

async function cmdSetup(argv) {
  const { flags } = parseArgs(argv);
  const nodeOk = Number(process.versions.node.split(".")[0]) >= MIN_NODE_MAJOR;
  const report = {
    ready: false,
    node: { version: process.version, ok: nodeOk },
    dsh: { found: false, path: null, version: null, error: null },
    minimalTask: null,
    suggestions: [],
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
async function cmdJob(command, argv) {
  const { flags, positional } = parseArgs(argv, ["cwd", "timeout-ms"]);
  if (positional.length > 1) fail("只能指定一个作业编号。", 2);
  if ("timeout-ms" in flags && (!flags.wait || !/^\d+$/.test(flags["timeout-ms"] ?? "") || !Number.isSafeInteger(Number(flags["timeout-ms"])))) {
    fail("--timeout-ms 必须与 --wait 配合，值为非负整数。", 2);
  }
  const root = resolveWorkspaceRoot(flags.cwd || process.cwd());
  const id = positional[0];
  const statusOptions = { wait: Boolean(flags.wait), all: Boolean(flags.all), timeoutMs: flags["timeout-ms"] === undefined ? undefined : Number(flags["timeout-ms"]) };
  const result = command === "status" ? await (id ? jobStatus(root, id, statusOptions) : jobStatuses(root, statusOptions))
    : command === "result" ? await jobResult(root, id) : await cancelJob(root, id);
  if (flags.json) out(JSON.stringify(result, null, 2));
  else if (command === "result") {
    if (result.ok) out(result.final);
    else out(`作业：${result.id}\n状态：${statusNames[result.status]}\n${result.error || "DeepSeek 任务失败。"}`);
  } else {
    const jobs = Array.isArray(result) ? result : [result];
    out(jobs.length ? jobs.map((job) => [
      `作业：${job.id}`, `种类：${job.kind}`, `状态：${statusNames[job.status]}（${job.status}）`,
      ...(command === "status" ? [`耗时：${job.elapsedMs} 毫秒`, ...(job.timedOut ? ["等待超时，作业继续运行。"] : []), ...job.progress] : []),
    ].join("\n")).join("\n\n") : "当前 Claude 会话没有作业。");
  }
}

const COMMANDS = { task: cmdTask, "task-resume-candidate": cmdTaskResumeCandidate, setup: cmdSetup,
  status: (argv) => cmdJob("status", argv), result: (argv) => cmdJob("result", argv), cancel: (argv) => cmdJob("cancel", argv),
};

async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  const handler = COMMANDS[sub];
  if (!handler) fail(`未知子命令：${sub ?? "(空)"}。可用：${Object.keys(COMMANDS).join("、")}`, 2);
  await handler(splitRawArgs(rest));
}

main().catch((err) => {
  process.stderr.write(`DeepSeek 命令失败：${err.message}\n`);
  process.exitCode = 1;
});
