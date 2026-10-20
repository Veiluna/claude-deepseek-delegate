import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { setup, makeGitRepo } from "./helpers.mjs";
import { setTimeout as delay } from "node:timers/promises";

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8",
    env: { ...process.env, GIT_CEILING_DIRECTORIES: fs.realpathSync(os.tmpdir()) } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function commit(cwd, message) {
  git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false",
    "-c", `core.hooksPath=${path.join(cwd, ".git/hooks")}`, "commit", "-qm", message);
}

function repository() {
  const cwd = makeGitRepo();
  fs.writeFileSync(path.join(cwd, "calc.mjs"), "export const total = 1;\n");
  git(cwd, "add", "calc.mjs");
  commit(cwd, "初始提交");
  git(cwd, "branch", "-M", "main");
  return cwd;
}

const review = {
  verdict: "needs-attention", summary: "边界条件有误。",
  findings: [{ severity: "high", title: "空输入失败", body: "空列表导致错误结果。", file: "calc.mjs",
    line_start: 1, line_end: 2, confidence: 0.95, recommendation: "覆盖空输入。" }],
  next_steps: ["补充空输入测试。"],
};

test("审阅范围为空时直接提示，不调用 dsh 或改变 git 状态", () => {
  const fixture = setup();
  const cwd = repository();
  const before = git(cwd, "status", "--porcelain=v1", "-z");
  for (const args of [["review"], ["review", "--scope", "working-tree"], ["review", "--scope", "branch", "--base", "main"], ["adversarial-review"]]) {
    const result = fixture.run(args, { cwd });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /没有可审阅的变更/);
    assert.equal(fs.existsSync(fixture.record), false);
    assert.equal(git(cwd, "status", "--porcelain=v1", "-z"), before);
  }
});

test("审阅采集暂存、未暂存和未跟踪内容，以只读运行并返回完整 schema，保持可续接线程", () => {
  const fixture = setup();
  const cwd = repository();
  assert.equal(fixture.run(["task", "原有任务"], { cwd, env: { FAKE_DSH_THREAD_ID: "task-thread" } }).code, 0);
  const candidate = fixture.run(["task-resume-candidate", "--json"], { cwd }).stdout;
  fs.writeFileSync(path.join(cwd, "calc.mjs"), "export const staged = 2;\n");
  git(cwd, "add", "calc.mjs");
  fs.writeFileSync(path.join(cwd, "calc.mjs"), "export const unstaged = 3;\n");
  fs.writeFileSync(path.join(cwd, "新 文件.txt"), "未跟踪正文\n");
  fs.writeFileSync(path.join(cwd, ".gitignore"), "ignored.txt\n");
  fs.writeFileSync(path.join(cwd, "ignored.txt"), "不能发送的被忽略内容");
  const before = git(cwd, "status", "--porcelain=v1", "-z");
  const result = fixture.run(["review", "--json"], { cwd: path.join(cwd, "sub"),
    env: { FAKE_DSH_FINAL: JSON.stringify(review), DSH_PERMISSION_MODE: "workspace-write" } });
  assert.equal(result.code, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.review, review);
  const record = fixture.readRecord();
  assert.equal(record.cwd, cwd);
  assert.equal(record.permissionMode, "read-only");
  assert.equal(record.argv.includes("--session-id"), false);
  assert.match(record.stdin, /staged = 2/);
  assert.match(record.stdin, /unstaged = 3/);
  assert.match(record.stdin, /新 文件\.txt/);
  assert.match(record.stdin, /未跟踪正文/);
  assert.doesNotMatch(record.stdin, /不能发送的被忽略内容/);
  assert.match(record.stdin, /只读/);
  assert.match(record.stdin, /只输出.*JSON/);
  assert.match(record.stdin, /confidence/);
  assert.match(record.stdin, /不要请求提升权限/);
  assert.equal(git(cwd, "status", "--porcelain=v1", "-z"), before);
  assert.equal(fixture.run(["task-resume-candidate", "--json"], { cwd }).stdout, candidate);
});

test("审阅容忍 JSON 代码块，并在文本结果中保留严重度、位置、置信度与建议", () => {
  const fixture = setup();
  const cwd = repository();
  fs.writeFileSync(path.join(cwd, "calc.mjs"), "export const total = 2;\n");
  const final = "\n```json\n" + JSON.stringify(review) + "\n```\n";
  const result = fixture.run(["review", "--json"], { cwd, env: { FAKE_DSH_FINAL: final } });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).review, review);
  const text = fixture.run(["review"], { cwd, env: { FAKE_DSH_FINAL: final } });
  assert.equal(text.code, 0, text.stderr);
  for (const content of ["needs-attention", "边界条件有误。", "[high]", "calc.mjs:1-2", "0.95", "覆盖空输入。", "补充空输入测试。"])
    assert.ok(text.stdout.includes(content), content);
});

for (const [name, data] of [
  ["非 JSON", "无法给出结构化审阅"],
  ["非对象", "null"],
  ["缺少结论", JSON.stringify({ summary: "摘要", findings: [], next_steps: [] })],
  ["未知结论", JSON.stringify({ ...review, verdict: "maybe" })],
  ["未知字段", JSON.stringify({ ...review, unexpected: true })],
  ["缺少置信度", JSON.stringify({ ...review, findings: [{ ...review.findings[0], confidence: undefined }] })],
  ["置信度越界", JSON.stringify({ ...review, findings: [{ ...review.findings[0], confidence: 2 }] })],
  ["行号无效", JSON.stringify({ ...review, findings: [{ ...review.findings[0], line_start: 0 }] })],
  ["严重度无效", JSON.stringify({ ...review, findings: [{ ...review.findings[0], severity: "unknown" }] })],
]) {
  test(`审阅解析失败（${name}）返回原始最终回复与明确错误，保留可续接线程`, () => {
    const fixture = setup();
    const cwd = repository();
    assert.equal(fixture.run(["task", "既有任务"], { cwd }).code, 0);
    const before = fixture.run(["task-resume-candidate", "--json"], { cwd }).stdout;
    fs.writeFileSync(path.join(cwd, "calc.mjs"), "export const changed = 2;\n");
    const failed = fixture.run(["review", "--json"], { cwd, env: { FAKE_DSH_FINAL: data } });
    assert.equal(failed.code, 1);
    const result = JSON.parse(failed.stdout);
    assert.equal(result.ok, false);
    assert.equal(result.review, null);
    assert.equal(result.final, data);
    assert.match(result.error, /schema.*JSON/);
    assert.equal(fixture.run(["task-resume-candidate", "--json"], { cwd }).stdout, before);
  });
}

test("--base 和 branch 使用共同祖先比较已提交差异，auto 在脏工作树选择 working-tree", () => {
  const fixture = setup({ FAKE_DSH_FINAL: JSON.stringify(review) });
  const cwd = repository();
  git(cwd, "checkout", "-qb", "feature");
  fs.writeFileSync(path.join(cwd, "calc.mjs"), "export const featureOnly = 2;\n");
  git(cwd, "add", "calc.mjs");
  commit(cwd, "功能变更");
  git(cwd, "checkout", "-q", "main");
  fs.writeFileSync(path.join(cwd, "main-only.txt"), "不能误算成被删除的主线变更\n");
  git(cwd, "add", "main-only.txt");
  commit(cwd, "主线独立前进");
  git(cwd, "checkout", "-q", "feature");
  for (const flags of [[], ["--base", "main"], ["--scope", "branch"]]) {
    const result = fixture.run(["review", ...flags, "--json"], { cwd });
    assert.equal(result.code, 0, result.stderr);
    assert.match(fixture.readRecord().stdin, /审阅范围：branch/);
    assert.match(fixture.readRecord().stdin, /featureOnly = 2/);
    assert.doesNotMatch(fixture.readRecord().stdin, /不能误算成被删除的主线变更/);
  }
  fs.writeFileSync(path.join(cwd, "local-only.txt"), "只在工作树的变更\n");
  assert.equal(fixture.run(["review", "--json"], { cwd }).code, 0);
  assert.match(fixture.readRecord().stdin, /审阅范围：working-tree/);
  assert.match(fixture.readRecord().stdin, /只在工作树的变更/);
  assert.equal(fixture.run(["review", "--base", "main", "--json"], { cwd }).code, 0);
  assert.doesNotMatch(fixture.readRecord().stdin, /只在工作树的变更/);
});

test("后台审阅立即返回审阅种类的作业，结果保留结构与文本且不改变可续接线程", async () => {
  const fixture = setup();
  const cwd = repository();
  assert.equal(fixture.run(["task", "既有任务"], { cwd, env: { FAKE_DSH_THREAD_ID: "kept-thread" } }).code, 0);
  const before = fixture.run(["task-resume-candidate", "--json"], { cwd }).stdout;
  fs.writeFileSync(path.join(cwd, "new.txt"), "审阅此变更");
  const started = Date.now();
  const result = fixture.run(["review", "--background", "--json"], { cwd,
    env: { FAKE_DSH_FINAL: JSON.stringify(review), FAKE_DSH_DELAY_MS: "2000" } });
  assert.equal(result.code, 0, result.stderr);
  const job = JSON.parse(result.stdout);
  assert.ok(job.id);
  assert.equal(job.kind, "review");
  assert.ok(Date.now() - started < 2000, "后台审阅不能等待 dsh 完成");
  try {
    const waited = fixture.run(["status", job.id, "--wait", "--timeout-ms", "20000", "--json"], { cwd });
    assert.equal(waited.code, 0, waited.stderr);
    assert.equal(JSON.parse(waited.stdout).status, "completed");
    assert.equal(fixture.readRecord().permissionMode, "read-only");
    assert.equal(fixture.run(["task-resume-candidate", "--json"], { cwd }).stdout, before);
    const taken = fixture.run(["result", job.id, "--json"], { cwd });
    assert.equal(taken.code, 0, taken.stderr);
    assert.deepEqual(JSON.parse(taken.stdout).review, review);
    const text = fixture.run(["result", job.id], { cwd });
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /置信度 0\.95/);
    assert.match(text.stdout, /建议：覆盖空输入/);
  } finally { fixture.run(["cancel", job.id], { cwd }); }
});

test("对抗式审阅挑战设计选择与假设，并保留用户关注点和只读权限", () => {
  const fixture = setup();
  const cwd = repository();
  fs.writeFileSync(path.join(cwd, "calc.mjs"), "export const total = 2;\n");
  const focus = "关注锁恢复；$(不要执行) 与 Windows 崩溃";
  const result = fixture.run(["adversarial-review", "--json", "--", focus], { cwd,
    env: { FAKE_DSH_FINAL: JSON.stringify(review) } });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).review, review);
  const record = fixture.readRecord();
  assert.equal(record.permissionMode, "read-only");
  assert.match(record.stdin, /挑战设计选择与假设/);
  assert.ok(record.stdin.includes(focus));
  assert.match(record.stdin, /权衡/);
  assert.match(record.stdin, /不.*修复/);
});

test("审阅模型与推理强度覆盖沿用临时配置，非法参数在调用 dsh 前拒绝", () => {
  const cwd = repository();
  fs.writeFileSync(path.join(cwd, "new.txt"), "变更");
  for (const args of [["--model"], ["--model="], ["--effort"], ["--effort", "medium"], ["--scope"], ["--base"]]) {
    const fixture = setup({ FAKE_DSH_FINAL: JSON.stringify(review) });
    const failed = fixture.run(["review", ...args, "--json"], { cwd });
    assert.equal(failed.code, 2, JSON.stringify(args) + failed.stderr);
    assert.equal(fs.existsSync(fixture.record), false);
  }
  const fixture = setup();
  const result = fixture.run(["review", "--model", "selected-model", "--effort", "max", "--json"], { cwd,
    env: { FAKE_DSH_FINAL: JSON.stringify(review) } });
  assert.equal(result.code, 0, result.stderr);
  const record = fixture.readRecord();
  assert.equal(record.permissionMode, "read-only");
  const patch = JSON.parse(record.patch);
  assert.equal(patch.find((item) => item.id === "agent-default-model").config.model, "selected-model");
  assert.equal(patch.find((item) => item.id === "llm-deepseek").config.reasoningEffort, "max");
  assert.equal(fs.existsSync(record.patchPath), false);
});

test("审阅采集不执行仓库配置的 fsmonitor、外部 diff 或 textconv", () => {
  const fixture = setup({ FAKE_DSH_FINAL: JSON.stringify(review) });
  const cwd = repository();
  const monitor = path.join(cwd, "monitor.mjs");
  const marker = path.join(cwd, "monitor-ran");
  fs.writeFileSync(monitor, `import fs from "node:fs";fs.writeFileSync(${JSON.stringify(marker)},"ran");process.stdout.write("token\\0");`);
  git(cwd, "config", "core.fsmonitor", `node "${monitor.replaceAll("\\", "/")}"`);
  git(cwd, "config", "diff.external", "missing-external-diff");
  git(cwd, "config", "diff.unsafe.textconv", "missing-textconv");
  fs.writeFileSync(path.join(cwd, ".gitattributes"), "calc.mjs diff=unsafe\n");
  fs.writeFileSync(path.join(cwd, "calc.mjs"), "export const total = 2;\n");
  const result = fixture.run(["review", "--scope", "working-tree", "--json"], { cwd });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(marker), false, "git status 的可选监视器不能在采集阶段执行");
  assert.match(fixture.readRecord().stdin, /total = 2/);
});

test("审阅预检包含未跟踪变更规模并建议执行方式，两个命令禁止模型自动调用", () => {
  const fixture = setup();
  const cwd = repository();
  fs.writeFileSync(path.join(cwd, "small.txt"), "小变更");
  let result = fixture.run(["review-context", "--json"], { cwd });
  assert.equal(result.code, 0, result.stderr);
  let context = JSON.parse(result.stdout);
  assert.equal(context.empty, false);
  assert.equal(context.fileCount, 1);
  assert.equal(context.suggestedMode, "foreground");
  for (const name of ["second.txt", "third.txt"]) fs.writeFileSync(path.join(cwd, name), "另一个变更");
  result = fixture.run(["review-context", "--json"], { cwd });
  assert.equal(result.code, 0, result.stderr);
  context = JSON.parse(result.stdout);
  assert.equal(context.fileCount, 3);
  assert.equal(context.suggestedMode, "background");
  assert.equal(fs.existsSync(fixture.record), false);
  for (const command of ["review", "adversarial-review"]) {
    const text = fs.readFileSync(new URL(`../commands/${command}.md`, import.meta.url), "utf8");
    assert.match(text, /disable-model-invocation: true/);
    assert.match(text, /review-context/);
    assert.match(text, /建议/);
    assert.match(text, /前台/);
    assert.match(text, /后台/);
    assert.match(text, /CLAUDE_PLUGIN_DATA="\$\{CLAUDE_PLUGIN_DATA\}"/);
    assert.match(text, /CLAUDE_SESSION_ID="\$\{CLAUDE_SESSION_ID\}"/);
    for (const flag of ["--base", "--scope", "--model", "--effort", "--background", "--json"]) assert.ok(text.includes(flag));
  }
});

test("初始提交前的暂存及未跟踪内容可审阅，特殊文件名和重命名不会遗漏正文", () => {
  const fixture = setup({ FAKE_DSH_FINAL: JSON.stringify(review) });
  const unborn = makeGitRepo();
  const empty = fixture.run(["review", "--json"], { cwd: unborn });
  assert.equal(empty.code, 0, empty.stderr);
  assert.equal(JSON.parse(empty.stdout).empty, true);
  fs.writeFileSync(path.join(unborn, "staged.txt"), "初始暂存正文");
  git(unborn, "add", "staged.txt");
  fs.writeFileSync(path.join(unborn, "名字 & () $.txt"), "特殊文件名正文");
  const first = fixture.run(["review", "--json"], { cwd: unborn });
  assert.equal(first.code, 0, first.stderr);
  assert.match(fixture.readRecord().stdin, /初始暂存正文/);
  assert.match(fixture.readRecord().stdin, /特殊文件名正文/);
  const cwd = repository();
  git(cwd, "mv", "calc.mjs", "new name.mjs");
  fs.writeFileSync(path.join(cwd, "untracked.txt"), "重命名之后的未跟踪正文");
  const moved = fixture.run(["review", "--json"], { cwd });
  assert.equal(moved.code, 0, moved.stderr);
  assert.match(fixture.readRecord().stdin, /new name\.mjs/);
  assert.match(fixture.readRecord().stdin, /重命名之后的未跟踪正文/);
});

test("无效范围和基准明确失败，不调用 dsh；大型未跟踪文件仍建议后台", () => {
  const cwd = repository();
  for (const flags of [["--scope", "staged"], ["--base", "missing-ref"], ["--base", "main", "--scope", "working-tree"], ["--base=--output=do-not-write"]]) {
    const fixture = setup();
    const result = fixture.run(["review", ...flags, "--json"], { cwd });
    assert.notEqual(result.code, 0);
    assert.ok(result.stderr.trim());
    assert.equal(fs.existsSync(fixture.record), false);
    assert.equal(fs.existsSync(path.join(cwd, "do-not-write")), false);
  }
  fs.writeFileSync(path.join(cwd, "large.txt"), "大".repeat(100000));
  const fixture = setup();
  const preview = fixture.run(["review-context", "--json"], { cwd });
  assert.equal(preview.code, 0, preview.stderr);
  const context = JSON.parse(preview.stdout);
  assert.equal(context.fileCount, 1);
  assert.equal(context.empty, false);
  assert.ok(context.diffBytes >= 300000);
  assert.equal(context.suggestedMode, "background");
  assert.equal(fs.existsSync(fixture.record), false);
});

test("后台对抗式审阅解析失败仍可取回原始最终回复，并可取消另一审阅作业", async () => {
  const fixture = setup();
  const cwd = repository();
  assert.equal(fixture.run(["task", "原有任务"], { cwd, env: { FAKE_DSH_THREAD_ID: "kept-task" } }).code, 0);
  const candidate = fixture.run(["task-resume-candidate", "--json"], { cwd }).stdout;
  fs.writeFileSync(path.join(cwd, "new.txt"), "需要审阅");
  const failed = fixture.run(["adversarial-review", "--background", "--json", "--", "关注恢复"], { cwd,
    env: { FAKE_DSH_FINAL: "原始非 JSON 回复" } });
  assert.equal(failed.code, 0, failed.stderr);
  const first = JSON.parse(failed.stdout);
  assert.equal(first.kind, "adversarial-review");
  const done = fixture.run(["status", first.id, "--wait", "--timeout-ms", "20000", "--json"], { cwd });
  assert.equal(done.code, 0, done.stderr);
  assert.equal(JSON.parse(done.stdout).status, "failed");
  const taken = fixture.run(["result", first.id, "--json"], { cwd });
  assert.equal(JSON.parse(taken.stdout).final, "原始非 JSON 回复");
  assert.equal(JSON.parse(taken.stdout).review, null);
  const text = fixture.run(["result", first.id], { cwd });
  assert.match(text.stdout, /schema.*JSON/);
  assert.match(text.stdout, /原始非 JSON 回复/);
  assert.match(fixture.readRecord().stdin, /关注恢复/);
  const slowRecord = path.join(cwd, "slow-record.json");
  const slow = fixture.run(["adversarial-review", "--background", "--json"], { cwd,
    env: { FAKE_DSH_FINAL: JSON.stringify(review), FAKE_DSH_DELAY_MS: "30000", FAKE_DSH_RECORD: slowRecord } });
  assert.equal(slow.code, 0, slow.stderr);
  const job = JSON.parse(slow.stdout);
  try {
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(slowRecord)) {
      assert.ok(Date.now() < deadline, "等待后台审阅开始超时");
      await delay(50);
    }
    assert.equal(JSON.parse(fs.readFileSync(slowRecord)).permissionMode, "read-only");
    const cancelled = fixture.run(["cancel", job.id, "--json"], { cwd });
    assert.equal(cancelled.code, 0, cancelled.stderr);
    assert.equal(JSON.parse(cancelled.stdout).status, "cancelled");
    assert.equal(fixture.run(["task-resume-candidate", "--json"], { cwd }).stdout, candidate);
  } finally { fixture.run(["cancel", job.id], { cwd }); }
});
