import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setup, makeGitRepo, tmpDir } from "./helpers.mjs";

test("foreground task prints DeepSeek's final reply", () => {
  const t = setup();
  const repo = makeGitRepo();
  const r = t.run(["task", "实现", "add", "函数"], { cwd: repo });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "完成：已处理任务\n");
});

test("task text goes through stdin with preamble, Chinese intact", () => {
  const t = setup();
  const repo = makeGitRepo();
  t.run(["task", "给", "工具函数补测试"], { cwd: repo });
  const rec = t.readRecord();
  assert.deepEqual(rec.argv, ["--profile", "headless", "--json", "-"]);
  assert.ok(rec.stdin.startsWith("给 工具函数补测试"));
  assert.match(rec.stdin, /只在当前工作区内写入/);
  assert.match(rec.stdin, /不要请求提升权限/);
  assert.match(rec.stdin, /覆盖已有文件前先读取/);
});

test("slash-command style single argument string is split", () => {
  const t = setup();
  const repo = makeGitRepo();
  const r = t.run(["task", "--read-only 查一下 为什么失败"], { cwd: repo });
  assert.equal(r.code, 0, r.stderr);
  const rec = t.readRecord();
  assert.equal(rec.permissionMode, "read-only");
  assert.ok(rec.stdin.startsWith("查一下 为什么失败"));
});

test("writable task by default, read-only with --read-only", () => {
  const t = setup();
  const repo = makeGitRepo();
  t.run(["task", "写代码"], { cwd: repo });
  assert.equal(t.readRecord().permissionMode, "workspace-write");
  t.run(["task", "--read-only", "看代码"], { cwd: repo });
  assert.equal(t.readRecord().permissionMode, "read-only");
});

test("permission mode is not leaked from the parent environment", () => {
  const t = setup();
  const repo = makeGitRepo();
  t.run(["task", "写代码"], { cwd: repo, env: { DSH_PERMISSION_MODE: "danger-full-access" } });
  assert.equal(t.readRecord().permissionMode, "workspace-write");
});

test("dsh runs in the git root even from a subdirectory", () => {
  const t = setup();
  const repo = makeGitRepo();
  t.run(["task", "x"], { cwd: path.join(repo, "sub") });
  assert.equal(fs.realpathSync(t.readRecord().cwd), repo);
});

test("dsh runs in the current directory outside git, and honours --cwd", () => {
  const t = setup();
  const plain = tmpDir("ds-plain-");
  t.run(["task", "x"], { cwd: plain });
  assert.equal(fs.realpathSync(t.readRecord().cwd), plain);
  const repo = makeGitRepo();
  t.run(["task", "--cwd", path.join(repo, "sub"), "x"], { cwd: plain });
  assert.equal(fs.realpathSync(t.readRecord().cwd), repo);
});

for (const [mode, expect] of [
  ["exit-nonzero", /退出码：3/],
  ["error", /错误：not logged in/],
  ["no-final", /没有收到最终回复/],
  ["incomplete", /结束原因：max_turns/],
  ["non-json", /this is not json/],
]) {
  test(`failure (${mode}) exits non-zero with raw output`, () => {
    const t = setup();
    const repo = makeGitRepo();
    const r = t.run(["task", "x"], { cwd: repo, env: { FAKE_DSH_MODE: mode } });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /DeepSeek 任务失败/);
    assert.match(r.stderr, expect);
  });
}

test("--json reports the thread id and result", () => {
  const t = setup();
  const repo = makeGitRepo();
  const r = t.run(["task", "--json", "x"], { cwd: repo });
  assert.equal(r.code, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true);
  assert.equal(j.threadId, "thr_fake_1");
  assert.equal(j.final, "完成：已处理任务");
});

test("missing dsh gives a clear error pointing at /deepseek:setup", () => {
  const t = setup();
  const repo = makeGitRepo();
  const r = t.run(["task", "x"], { cwd: repo, env: { DSH_BIN: path.join(repo, "nope", "dsh") } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /DSH_BIN 指向的文件不存在/);
  assert.match(r.stderr, /\/deepseek:setup/);
});

test("empty task description is rejected", () => {
  const t = setup();
  const r = t.run(["task"], { cwd: makeGitRepo() });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /用法/);
});
