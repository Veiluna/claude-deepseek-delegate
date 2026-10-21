import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setup, makeGitRepo } from "./helpers.mjs";
import { setTimeout as delay } from "node:timers/promises";

const entry = fileURLToPath(new URL("../scripts/deepseek-host.mjs", import.meta.url));
function fixture() {
  const old = setup();
  const cwd = makeGitRepo();
  const shared = path.join(path.dirname(old.data), "shared");
  const target = path.join(shared, "projects");
  const options = (extra = {}) => ({ cwd, encoding: "utf8", env: { ...process.env,
    DEEPSEEK_DATA_DIR: shared, CLAUDE_PLUGIN_DATA: old.data, DSH_BIN: old.bin, FAKE_DSH_RECORD: old.record,
    GIT_CEILING_DIRECTORIES: fs.realpathSync(os.tmpdir()), ...extra } });
  const run = (args, extra = {}, nodeArgs = []) => {
    const result = spawnSync(process.execPath, [...nodeArgs, entry, "claude", ...args], options(extra));
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const seed = (root, id) => {
    const before = fs.existsSync(old.data) ? fs.readdirSync(old.data) : [];
    const result = old.run(["task-resume-candidate", "--json"], { cwd: root });
    assert.equal(result.code, 0, result.stderr);
    const key = fs.readdirSync(old.data).find((name) => !before.includes(name));
    const project = path.join(old.data, key);
    const state = { resumableThread: { threadId: `thr_${id}`, summary: `候选${id}`, extraCandidate: [7] }, extraState: { preserve: true } };
    const job = { id, kind: "task", status: "completed", claudeSessionId: "old-claude", workspaceRoot: root,
      createdAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", startedAt: "2026-01-01T00:00:00.000Z",
      pid: null, dshPid: null, logPath: path.join(project, "jobs", `${id}.log`), extraJob: { keep: "unknown" },
      result: { ok: true, final: `结果${id}`, extraResult: [9] } };
    fs.writeFileSync(path.join(project, "state.json"), JSON.stringify(state));
    fs.writeFileSync(path.join(project, "jobs", `${id}.json`), JSON.stringify(job));
    fs.writeFileSync(job.logPath, `完整日志${id}\n`);
    return { key, project, job, state };
  };
  return { ...old, cwd, shared, target, options, run, seed };
}

test("setup 显式迁移全部项目候选与终态作业日志，保留源及未知字段且不调用 dsh", () => {
  const f = fixture();
  const first = f.seed(f.cwd, "first");
  const second = f.seed(makeGitRepo(), "second");
  const before = [first, second].map(({ project, job }) => [
    fs.readFileSync(path.join(project, "state.json"), "utf8"), fs.readFileSync(path.join(project, "jobs", `${job.id}.json`), "utf8"), fs.readFileSync(job.logPath, "utf8"),
  ]);
  const result = f.run(["setup", "--migrate-from", f.data, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).migration.projects, 2);
  assert.equal(fs.existsSync(f.record), false, "迁移不能运行连通性任务");
  for (const [i, { key, project, job, state }] of [first, second].entries()) {
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.target, key, "state.json"), "utf8")), state);
    const copied = JSON.parse(fs.readFileSync(path.join(f.target, key, "jobs", `${job.id}.json`), "utf8"));
    assert.deepEqual(copied, { ...job, logPath: path.join(f.target, key, "jobs", `${job.id}.log`) });
    assert.equal(fs.readFileSync(copied.logPath, "utf8"), before[i][2]);
    assert.deepEqual([fs.readFileSync(path.join(project, "state.json"), "utf8"), fs.readFileSync(path.join(project, "jobs", `${job.id}.json`), "utf8"), fs.readFileSync(job.logPath, "utf8")], before[i]);
  }
  const candidate = f.run(["task-resume-candidate", "--json"]);
  assert.equal(candidate.code, 0, candidate.stderr);
  assert.equal(JSON.parse(candidate.stdout).threadId, "thr_first");
  const jobs = f.run(["status", "--all", "--json"]);
  assert.equal(jobs.code, 0, jobs.stderr);
  assert.equal(JSON.parse(jobs.stdout)[0].claudeSessionId, "old-claude");
  assert.deepEqual(JSON.parse(jobs.stdout)[0].progress, ["完整日志first"]);
});

for (const status of ["queued", "running", "unknown"]) {
  test(`迁移遇到 ${status} 作业停止，不取消、不恢复、不发布目标`, () => {
    const f = fixture();
    const seeded = f.seed(f.cwd, "active");
    const file = path.join(seeded.project, "jobs", "active.json");
    const bytes = JSON.stringify({ ...seeded.job, status, pid: process.pid, dshPid: process.pid, cancelRequestedAt: "pending" });
    fs.writeFileSync(file, bytes);
    const result = f.run(["setup", "--migrate-from", f.data, "--json"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /活动|状态|终态/);
    assert.equal(fs.readFileSync(file, "utf8"), bytes);
    assert.equal(fs.existsSync(f.target), false);
    assert.equal(fs.existsSync(f.record), false);
    assert.doesNotThrow(() => process.kill(process.pid, 0));
  });
}

test("目标有数据时停止，空目标可以发布完整迁移", () => {
  const f = fixture();
  f.seed(f.cwd, "done");
  fs.mkdirSync(f.target, { recursive: true });
  const sentinel = path.join(f.target, "do-not-overwrite");
  fs.writeFileSync(sentinel, "preserved");
  const denied = f.run(["setup", "--migrate-from", f.data, "--json"]);
  assert.notEqual(denied.code, 0);
  assert.match(denied.stderr, /目标已有数据/);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "preserved");
  assert.equal(fs.existsSync(f.record), false);
  fs.rmSync(sentinel);
  const allowed = f.run(["setup", "--migrate-from", f.data, "--json"]);
  assert.equal(allowed.code, 0, allowed.stderr);
  assert.equal(JSON.parse(allowed.stdout).migration.jobs, 1);
});

test("数值编号终态作业即使文件名匹配也必须拒绝迁移，源保持不变", () => {
  const f = fixture();
  const seeded = f.seed(f.cwd, "done");
  const directory = path.join(seeded.project, "jobs");
  const logPath = path.join(directory, "7.log");
  fs.renameSync(seeded.job.logPath, logPath);
  fs.rmSync(path.join(directory, "done.json"));
  const file = path.join(directory, "7.json");
  const content = JSON.stringify({ ...seeded.job, id: 7, logPath });
  fs.writeFileSync(file, content);
  const result = f.run(["setup", "--migrate-from", f.data, "--json"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /迁移作业记录损坏/);
  assert.equal(fs.existsSync(f.target), false);
  assert.equal(fs.readFileSync(file, "utf8"), content);
  assert.equal(fs.readFileSync(logPath, "utf8"), "完整日志done\n");
  assert.deepEqual(fs.readdirSync(directory).sort(), ["7.json", "7.log"]);
  assert.equal(fs.existsSync(f.record), false);
});

test("共享根已有宿主登记仍可显式迁移，登记不参与项目快照发布", () => {
  const f = fixture();
  f.seed(f.cwd, "done");
  const hosts = path.join(f.shared, "hosts");
  fs.mkdirSync(hosts, { recursive: true });
  fs.writeFileSync(path.join(hosts, "registered.json"), "private-registration");
  const result = f.run(["setup", "--migrate-from", f.data, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(fs.existsSync(f.target));
  assert.equal(fs.readFileSync(path.join(hosts, "registered.json"), "utf8"), "private-registration");
});

test("迁移拒绝源或共享根的父路径链接，不通过别名读写其他目录", () => {
  for (const which of ["source", "target"]) {
    const f = fixture();
    f.seed(f.cwd, "done");
    const alias = path.join(path.dirname(f.data), "alias");
    fs.mkdirSync(f.shared);
    fs.symlinkSync(which === "source" ? f.data : f.shared, alias, process.platform === "win32" ? "junction" : "dir");
    const result = f.run(["setup", "--migrate-from", which === "source" ? alias : f.data, "--json"], which === "target" ? { DEEPSEEK_DATA_DIR: alias } : {});
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /不安全/);
    assert.equal(fs.existsSync(f.target), false);
  }
});

for (const damage of ["state-json", "state-shape", "candidate", "job-json", "job-id", "finished-missing", "finished-invalid", "created-number", "log-escape", "missing-log", "linked-log", "linked-project", "unknown-file"]) {
  test(`损坏或不安全源（${damage}）不会发布迁移或泄漏记录正文`, () => {
    const f = fixture();
    const seeded = f.seed(f.cwd, "done");
    const stateFile = path.join(seeded.project, "state.json");
    const jobFile = path.join(seeded.project, "jobs", "done.json");
    const secret = "sensitive-token-do-not-echo";
    if (damage === "state-json") fs.writeFileSync(stateFile, secret);
    if (damage === "state-shape") fs.writeFileSync(stateFile, "[]");
    if (damage === "candidate") fs.writeFileSync(stateFile, JSON.stringify({ resumableThread: { threadId: 7, summary: secret } }));
    if (damage === "job-json") fs.writeFileSync(jobFile, secret);
    if (damage === "job-id") fs.writeFileSync(jobFile, JSON.stringify({ ...seeded.job, id: "../../escape" }));
    if (damage === "finished-missing") { const job = { ...seeded.job }; delete job.finishedAt; fs.writeFileSync(jobFile, JSON.stringify(job)); }
    if (damage === "finished-invalid") fs.writeFileSync(jobFile, JSON.stringify({ ...seeded.job, finishedAt: "invalid" }));
    if (damage === "created-number") fs.writeFileSync(jobFile, JSON.stringify({ ...seeded.job, createdAt: 7 }));
    if (damage === "log-escape") fs.writeFileSync(jobFile, JSON.stringify({ ...seeded.job, logPath: path.join(path.dirname(f.data), "outside.log") }));
    if (damage === "missing-log") fs.rmSync(seeded.job.logPath);
    if (damage === "linked-log") {
      const outside = path.join(path.dirname(f.data), "outside.log");
      fs.writeFileSync(outside, secret);
      // 目录 junction 在 Windows 无需符号链接特权；日志路径也必须被拒绝。
      fs.rmSync(seeded.job.logPath);
      fs.symlinkSync(path.dirname(f.data), seeded.job.logPath, process.platform === "win32" ? "junction" : "dir");
    }
    if (damage === "linked-project") fs.symlinkSync(seeded.project, path.join(f.data, "linked-0123456789ab"), process.platform === "win32" ? "junction" : "dir");
    if (damage === "unknown-file") fs.writeFileSync(path.join(seeded.project, "unrecognized.json"), secret);
    const result = f.run(["setup", "--migrate-from", f.data, "--json"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /迁移/);
    assert.doesNotMatch(result.stderr, new RegExp(secret));
    assert.equal(fs.existsSync(f.target), false);
    assert.equal(fs.existsSync(f.record), false);
  });
}

function preload(f, body) {
  const file = path.join(path.dirname(f.data), "migration-preload.cjs");
  fs.writeFileSync(file, `const fs = require('node:fs'); const path = require('node:path');\n${body}`);
  return ["--require", file];
}

for (const code of ["EPERM", "EACCES", "EBUSY"]) {
  test(`Windows 发布项目目录短暂${code}后重试完整rename`, { skip: process.platform !== "win32" }, () => {
    const f = fixture();
    f.seed(f.cwd, "done");
    const args = preload(f, `
      const rename = fs.renameSync;
      let injected = false;
      fs.renameSync = function(from, to) {
        if (!injected && path.basename(String(from)).startsWith('.projects.migration-') && path.basename(String(to)) === 'projects') {
          injected = true;
          throw Object.assign(new Error('temporarily busy'), {code:${JSON.stringify(code)}});
        }
        return rename.apply(this, arguments);
      };`);
    const result = f.run(["setup", "--migrate-from", f.data, "--json"], {}, args);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).migration.jobs, 1);
    assert.ok(fs.existsSync(f.target));
  });
}

for (const failure of ["write-failure", "process-exit", "source-changed"]) {
  test(`迁移${failure}不暴露半成品，保留源后可显式重试`, () => {
    const f = fixture();
    const seeded = f.seed(f.cwd, "done");
    const sourceState = path.join(seeded.project, "state.json");
    const args = preload(f, `
      const rename = fs.renameSync;
      fs.renameSync = function(from, to) {
        const inStage = String(to).includes('.projects.migration-');
        if (inStage && path.basename(String(to)) === 'state.json') {
          if (${JSON.stringify(failure)} === 'write-failure') throw Object.assign(new Error('simulated EIO'), {code:'EIO'});
          if (${JSON.stringify(failure)} === 'process-exit') process.exit(23);
          fs.writeFileSync(${JSON.stringify(sourceState)}, JSON.stringify({resumableThread:{threadId:'thr_changed',summary:'并发旧调用'}}));
        }
        return rename.apply(this, arguments);
      };`);
    const result = f.run(["setup", "--migrate-from", f.data, "--json"], {}, args);
    assert.notEqual(result.code, 0);
    assert.equal(fs.existsSync(f.target), false);
    assert.ok(fs.existsSync(sourceState));
    assert.ok(fs.existsSync(seeded.job.logPath));
    assert.equal(fs.existsSync(f.record), false);
    if (failure === "source-changed") assert.match(result.stderr, /源数据发生变化/);
    const retried = f.run(["setup", "--migrate-from", f.data, "--json"]);
    assert.equal(retried.code, 0, retried.stderr);
    const candidate = f.run(["task-resume-candidate", "--json"]);
    assert.equal(candidate.code, 0, candidate.stderr);
    assert.equal(JSON.parse(candidate.stdout).threadId, failure === "source-changed" ? "thr_changed" : "thr_done");
  });
}

test("迁移持发布门闩时新入口等待，发布后只读取完整候选和日志", async () => {
  const f = fixture();
  f.seed(f.cwd, "done");
  const signal = path.join(path.dirname(f.data), "paused");
  const release = path.join(path.dirname(f.data), "release");
  const args = preload(f, `
    const rename = fs.renameSync;
    fs.renameSync = function(from, to) {
      if (String(to).includes('.projects.migration-') && path.basename(String(to)) === 'state.json') {
        fs.writeFileSync(${JSON.stringify(signal)}, 'ready');
        const wait = new Int32Array(new SharedArrayBuffer(4));
        const deadline = Date.now() + 15000;
        while (!fs.existsSync(${JSON.stringify(release)})) {
          if (Date.now() > deadline) throw new Error('测试等待释放超时');
          Atomics.wait(wait, 0, 0, 25);
        }
      }
      return rename.apply(this, arguments);
    };`);
  const start = (argv) => {
    const child = spawn(process.execPath, argv, f.options());
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const done = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve({ code, stdout, stderr })); });
    return { child, done };
  };
  const migration = start([...args, entry, "claude", "setup", "--migrate-from", f.data, "--json"]);
  let ordinary;
  try {
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(signal)) { assert.ok(Date.now() < deadline); await delay(25); }
    ordinary = start([entry, "codex", "task-resume-candidate", "--json"]);
    await delay(500);
    assert.equal(ordinary.child.exitCode, null);
    assert.equal(fs.existsSync(f.target), false);
  } finally {
    fs.writeFileSync(release, "continue");
  }
  const published = await migration.done;
  assert.equal(published.code, 0, published.stderr);
  const queried = await ordinary.done;
  assert.equal(queried.code, 0, queried.stderr);
  assert.equal(JSON.parse(queried.stdout).threadId, "thr_done");
});
