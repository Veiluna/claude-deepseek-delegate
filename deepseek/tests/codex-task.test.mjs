import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setup, makeGitRepo } from "./helpers.mjs";

const entry = fileURLToPath(new URL("../scripts/deepseek-host.mjs", import.meta.url));

function fixture(t) {
  const fake = setup();
  const cwd = makeGitRepo();
  const work = path.dirname(fake.data);
  t.after(() => {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const run = (host, argv, { input, env = {}, sessionId = "codex-real-session" } = {}) => {
    const identity = sessionId ? ["--session-id", sessionId] : [];
    const r = spawnSync(process.execPath, [entry, host, ...identity, ...argv], {
      cwd, encoding: "utf8", input, env: {
        ...process.env, DSH_BIN: fake.bin, FAKE_DSH_RECORD: fake.record,
        DEEPSEEK_DATA_DIR: path.join(work, "shared"), CLAUDE_PLUGIN_DATA: fake.data,
        CLAUDE_SESSION_ID: "inherited-claude-session", CODEX_THREAD_ID: "inherited-codex-session",
        GIT_CEILING_DIRECTORIES: fs.realpathSync(os.tmpdir()), ...env,
      },
    });
    assert.equal(r.error, undefined);
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return { ...fake, cwd, run };
}

test("Codex 前台任务从 stdin 保留原文、换行和 shell 特殊字符", (t) => {
  const f = fixture(t);
  const marker = path.join(f.cwd, "must-not-execute");
  const prompt = `  中文 '双引号\"' $HOME \u0060命令\u0060\r\n$(touch ${marker}) & | ; >\n--resume --model fake\n  `;
  const r = f.run("codex", ["task", "--fresh", "--prompt-stdin", "--json"], { input: prompt });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).final, "完成：已处理任务");
  assert.ok(f.readRecord().stdin.startsWith(prompt + "\n"));
  assert.deepEqual(f.readRecord().argv, ["--profile", "headless", "--json", "-"]);
  assert.equal(fs.existsSync(marker), false);
});

for (const [name, argv, input, error] of [
  ["空输入", ["--prompt-stdin"], "", /stdin 正文不能为空/],
  ["只有空白", ["--prompt-stdin"], " \r\n\t", /stdin 正文不能为空/],
  ["混用位置正文", ["--prompt-stdin", "--", "另一正文"], "stdin 正文", /位置正文不能同时指定/],
  ["空位置正文仍互斥", ["--prompt-stdin", "--", ""], "stdin 正文", /位置正文不能同时指定/],
  ["标志不接收值", ["--prompt-stdin=false"], "stdin 正文", /不接受参数值/],
]) {
  test(`Codex stdin 任务拒绝${name}且不启动 dsh`, (t) => {
    const f = fixture(t);
    const r = f.run("codex", ["task", ...argv], { input });
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, error);
    assert.equal(fs.existsSync(f.record), false);
  });
}

test("Codex setup 采用显式当前编号，缺失身份保持未知，并只运行只读检查", (t) => {
  const f = fixture(t);
  for (const sessionId of ["current-codex-id", null]) {
    const r = f.run("codex", ["setup", "--json"], { sessionId });
    assert.equal(r.code, 0, r.stderr);
    const report = JSON.parse(r.stdout);
    assert.equal(report.ready, true);
    assert.equal(report.hostContext.host, "codex");
    assert.equal(report.hostContext.sessionId, sessionId);
    assert.equal(f.readRecord().permissionMode, "read-only");
  }
});

test("Claude 与 Codex 双向续接同一候选，每次重新决定权限和工作目录", (t) => {
  const f = fixture(t);
  const sub = path.join(f.cwd, "目录 with spaces");
  fs.mkdirSync(sub);
  const initial = f.run("claude", ["task", "--fresh", "--prompt-stdin", "--json", "--read-only"], {
    sessionId: "claude-real-session", input: "第一次只读任务", env: { FAKE_DSH_THREAD_ID: "shared-thread" },
  });
  assert.equal(initial.code, 0, initial.stderr);
  for (const [host, mode, extra] of [["codex", "workspace-write", []], ["claude", "read-only", ["--read-only"]]]) {
    const query = f.run(host, ["task-resume-candidate", "--cwd", sub, "--json"]);
    assert.equal(query.code, 0, query.stderr);
    const candidate = JSON.parse(query.stdout);
    assert.equal(candidate.threadId, "shared-thread");
    const r = f.run(host, ["task", "--resume", "--expected-thread-id", candidate.threadId,
      "--cwd", sub, ...extra, "--prompt-stdin", "--json"], { input: "继续\n--fresh 这是正文", env: { FAKE_DSH_THREAD_ID: "shared-thread" } });
    assert.equal(r.code, 0, r.stderr);
    const rec = f.readRecord();
    assert.equal(rec.permissionMode, mode);
    assert.equal(fs.realpathSync(rec.cwd), f.cwd);
    assert.deepEqual(rec.argv, ["--profile", "headless", "--json", "--session-id", "shared-thread", "-"]);
    assert.ok(rec.stdin.startsWith("继续\n--fresh 这是正文\n"));
  }
  const before = fs.readFileSync(f.record, "utf8");
  const changed = f.run("codex", ["task", "--resume", "--expected-thread-id", "changed-candidate", "--prompt-stdin"], { input: "不得执行" });
  assert.equal(changed.code, 1);
  assert.match(changed.stderr, /可续接线程已变化/);
  assert.equal(fs.readFileSync(f.record, "utf8"), before);
});

test("Codex task 未指定覆盖不读取配置，显式模型与 effort 只影响本次", (t) => {
  const f = fixture(t);
  const first = f.run("codex", ["task", "--fresh", "--prompt-stdin"], { input: "默认任务" });
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(f.readRecord().argv, ["--profile", "headless", "--json", "-"]);
  const before = fs.readFileSync(f.record + ".calls.jsonl", "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(before.length, 1);
  const model = "model; $HOME & 'quoted'";
  const r = f.run("codex", ["task", "--fresh", "--read-only", "--model", model, "--effort", "max", "--prompt-stdin"], { input: "仅本次覆盖" });
  assert.equal(r.code, 0, r.stderr);
  const rec = f.readRecord();
  const patches = JSON.parse(rec.patch);
  assert.equal(patches.find((p) => p.id === "agent-default-model").config.model, model);
  assert.equal(patches.find((p) => p.id === "llm-deepseek").config.reasoningEffort, "max");
  assert.equal(rec.permissionMode, "read-only");
  assert.equal(fs.existsSync(rec.patchPath), false);
  const next = f.run("codex", ["task", "--fresh", "--prompt-stdin"], { input: "恢复默认" });
  assert.equal(next.code, 0, next.stderr);
  assert.equal(f.readRecord().patch, null);
  assert.equal(f.readRecord().permissionMode, "workspace-write");
});

for (const [mode, error] of [["no-final", /没有收到最终回复/], ["incomplete", /max_turns/],
  ["exit-nonzero", /退出码：3/], ["error", /not logged in/]]) {
  test(`Codex task 保留 ${mode} 错误且不把截断进度当最终回复`, (t) => {
    const f = fixture(t);
    const r = f.run("codex", ["task", "--fresh", "--prompt-stdin"], { input: "不会伪报成功", env: { FAKE_DSH_MODE: mode } });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, error);
    assert.match(r.stderr, /--- 原始输出 ---/);
  });
}

test("skill 固定启动代码以数据文件传正文并显式传递真实 Codex 编号", (t) => {
  const f = fixture(t);
  const reference = fs.readFileSync(new URL("../references/codex-cli.md", import.meta.url), "utf8");
  const code = reference.match(/```javascript\r?\n([\s\S]*?)```/)[1];
  const plugin = fileURLToPath(new URL("../", import.meta.url));
  const requestFile = path.join(f.cwd, "请求 'quoted'.json");
  const marker = path.join(f.cwd, "must-not-execute");
  const prompt = `\n$(touch ${marker})\n'\"\u0060 & | --read-only\n `;
  const call = (args, body) => {
    fs.writeFileSync(requestFile, JSON.stringify({ args, ...(body === undefined ? {} : { prompt: body }) }));
    return spawnSync(process.execPath, ["-e", code, requestFile, plugin], { cwd: f.cwd, encoding: "utf8", env: {
      ...process.env, CODEX_THREAD_ID: "actual-codex-session", CLAUDE_SESSION_ID: "different-claude-session",
      DEEPSEEK_DATA_DIR: path.join(path.dirname(f.data), "shared"), DSH_BIN: f.bin, FAKE_DSH_RECORD: f.record,
      GIT_CEILING_DIRECTORIES: fs.realpathSync(os.tmpdir()),
    } });
  };
  const check = call(["setup", "--json"]);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(JSON.parse(check.stdout).hostContext.sessionId, "actual-codex-session");
  const r = call(["task", "--fresh", "--prompt-stdin"], prompt);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(f.readRecord().stdin.startsWith(prompt + "\n"));
  assert.equal(f.readRecord().permissionMode, "workspace-write");
  assert.equal(fs.existsSync(marker), false);
});
