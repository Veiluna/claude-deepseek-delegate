import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { setup, makeGitRepo } from "./helpers.mjs";

function json(t, cwd, args, env = {}) {
  const r = t.run([...args, "--json"], { cwd, env });
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("作业在父命令退出后继续执行，status --wait 和 result 能取回 final", () => {
  const t = setup();
  const repo = makeGitRepo();
  const started = Date.now();
  const job = json(t, path.join(repo, "sub"), ["task", "--background", "--read-only", "检查代码"], {
    FAKE_DSH_DELAY_MS: "2500", CLAUDE_SESSION_ID: "claude-test-6",
  });
  assert.ok(job.id);
  assert.ok(Date.now() - started < 2000, "后台启动不应等待 dsh 完成");
  assert.ok(["queued", "running"].includes(job.status));
  const done = json(t, repo, ["status", job.id, "--wait", "--timeout-ms", "15000"]);
  assert.equal(done.kind, "task");
  assert.equal(done.status, "completed");
  assert.equal(done.claudeSessionId, "claude-test-6");
  assert.ok(Number.isInteger(done.pid));
  assert.ok(done.createdAt && done.startedAt && done.finishedAt);
  assert.ok(done.elapsedMs >= 2000);
  assert.ok(fs.existsSync(done.logPath));
  assert.ok(done.progress.length > 0 && done.progress.length <= 5);
  assert.equal(fs.realpathSync(t.readRecord().cwd), repo);
  assert.equal(t.readRecord().permissionMode, "read-only");
  assert.match(t.readRecord().stdin, /不要请求提升权限/);
  const result = json(t, repo, ["result"]);
  assert.equal(result.id, job.id);
  assert.equal(result.final, "完成：已处理任务");
  assert.doesNotMatch(result.final, /截断/);
  assert.equal(json(t, repo, ["task-resume-candidate"]).threadId, "thr_fake_1");
});

async function until(fn, describe = () => "") {
  const deadline = Date.now() + 15000;
  for (;;) {
    if (fn()) return;
    assert.ok(Date.now() < deadline, `等待作业状态变化超时${Date.now() >= deadline ? describe() : ""}`);
    await delay(50);
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux" && fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z")) return false;
    return true;
  } catch (err) { if (["ESRCH", "ENOENT"].includes(err.code)) return false; throw err; }
}

test("status 显示运行进度，等待超时不终止作业，取消结束整个进程树且可重复调用", async () => {
  const t = setup();
  const repo = makeGitRepo();
  const tree = path.join(repo, "tree.jsonl");
  const job = json(t, repo, ["task", "--background", "慢任务"], { FAKE_DSH_DELAY_MS: "30000", FAKE_DSH_TREE: tree });
  try {
    await until(() => fs.existsSync(tree) && fs.readFileSync(tree, "utf8").trim().split("\n").length === 2);
    const running = json(t, repo, ["status", job.id, "--wait", "--timeout-ms", "50"]);
    assert.equal(running.status, "running");
    assert.equal(running.timedOut, true);
    assert.ok(running.progress.some((line) => /turn_start/.test(line)));
    const readable = t.run(["status", job.id], { cwd: repo });
    assert.equal(readable.code, 0, readable.stderr);
    assert.match(readable.stdout, /种类：task/);
    assert.match(readable.stdout, /状态：运行/);
    assert.match(readable.stdout, /耗时：\d+ 毫秒/);
    const pending = t.run(["result", job.id], { cwd: repo });
    assert.equal(pending.code, 1);
    assert.match(pending.stderr, /尚未结束/);
    const descendants = fs.readFileSync(tree, "utf8").trim().split("\n").map(JSON.parse);
    const fakePid = t.readRecord().pid;
    assert.ok(descendants.every(({ pid }) => alive(pid)));
    assert.equal(json(t, repo, ["cancel", job.id]).status, "cancelled");
    await until(() => [job.pid, fakePid, ...descendants.map(({ pid }) => pid)].every((pid) => !alive(pid)));
    assert.equal(json(t, repo, ["cancel", job.id]).status, "cancelled");
    assert.equal(json(t, repo, ["status", job.id]).status, "cancelled");
    assert.equal(json(t, repo, ["result", job.id]).final, null);
  } finally { t.run(["cancel", job.id], { cwd: repo }); }
});

test("worker 崩溃后 status 恢复为失败并清理仍存活的 dsh 后代", async (context) => {
  const t = setup();
  const repo = makeGitRepo();
  const tree = path.join(repo, "tree.jsonl");
  const job = json(t, repo, ["task", "--background", "慢任务"], { FAKE_DSH_DELAY_MS: "30000", FAKE_DSH_TREE: tree });
  const recordPath = path.join(path.dirname(job.logPath), `${job.id}.json`);
  const selectState = ({ id, status, pid, dshPid, createdAt, startedAt, finishedAt, cancelRequestedAt, error }) => ({
    id, status, pid, dshPid, createdAt, startedAt, finishedAt, cancelRequestedAt, error,
  });
  const tracked = [{ role: "worker", pid: job.pid }];
  const snapshots = {};
  const snapshot = () => {
    // 只输出状态和 PID，不把任务正文、配置、进度或结果写入诊断。
    try {
      return {
        job: selectState(JSON.parse(fs.readFileSync(recordPath, "utf8"))),
        processes: tracked.map((entry) => ({ ...entry, alive: alive(entry.pid) })),
      };
    } catch (error) { return { diagnosticError: error.code || error.name }; }
  };
  const describe = () => `\n崩溃恢复诊断：${JSON.stringify({ ...snapshots, current: snapshot() }, null, 2)}`;
  try {
    await until(() => fs.existsSync(tree) && fs.readFileSync(tree, "utf8").trim().split("\n").length === 2, describe);
    const stored = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    tracked.push({ role: "dsh-root", pid: stored.dshPid }, { role: "fake-dsh", pid: t.readRecord().pid },
      ...fs.readFileSync(tree, "utf8").trim().split("\n").map(JSON.parse));
    snapshots.beforeCrash = snapshot();
    assert.equal(stored.status, "running", describe());
    assert.ok(Number.isInteger(stored.dshPid) && alive(stored.dshPid), describe());
    assert.ok(tracked.every(({ pid }) => alive(pid)), describe());
    process.kill(job.pid, "SIGKILL");
    await until(() => !alive(job.pid), describe);
    snapshots.beforeRecovery = snapshot();
    if (process.platform === "win32") {
      assert.ok(alive(stored.dshPid), `worker 退出后，独立 dsh 宿主必须仍可定位。${describe()}`);
    }
    const recovered = json(t, repo, ["status", job.id, "--wait", "--timeout-ms", "1000"]);
    snapshots.afterRecovery = { response: selectState(recovered), ...snapshot() };
    assert.equal(recovered.status, "failed", describe());
    assert.match(recovered.error, /worker.*退出/, describe());
    assert.ok(recovered.finishedAt, describe());
    await until(() => tracked.every(({ pid }) => !alive(pid)), describe);
    assert.equal(json(t, repo, ["result", job.id]).ok, false);
  } finally {
    // 终态 cancel 不会重新清理残留后代；失败后精确清理夹具，避免污染下一轮。
    // 此清理只在上述行为断言结束后执行，不参与测试通过条件。
    try { t.run(["cancel", job.id], { cwd: repo }); }
    finally {
      for (const pid of [...new Set(tracked.map(({ pid }) => pid))].reverse()) {
        if (!Number.isInteger(pid) || pid <= 0) continue;
        try { if (alive(pid)) process.kill(pid, "SIGKILL"); }
        catch (error) { context.diagnostic(`夹具清理失败：PID ${pid}，${error.code || error.name}`); }
      }
    }
  }
});

for (const crashed of [false, true]) {
  test(`dsh 先退出后仍清理分离子孙进程，${crashed ? "worker 崩溃由 status 恢复" : "失败终态不遗留后代"}`, async () => {
    const t = setup();
    const repo = makeGitRepo();
    const tree = path.join(repo, "orphan-tree.jsonl");
    const job = json(t, repo, ["task", "--background", "创建后代再失败"], {
      FAKE_DSH_ORPHAN_TREE: tree, FAKE_DSH_DELAY_MS: "1500", FAKE_DSH_MODE: "exit-nonzero",
    });
    const tracked = [job.pid];
    try {
      await until(() => fs.existsSync(tree) && fs.readFileSync(tree, "utf8").trim().split("\n").length === 2);
      const stored = JSON.parse(fs.readFileSync(path.join(path.dirname(job.logPath), `${job.id}.json`), "utf8"));
      const fakePid = t.readRecord().pid;
      tracked.push(stored.dshPid, fakePid, ...fs.readFileSync(tree, "utf8").trim().split("\n").map((line) => JSON.parse(line).pid));
      assert.ok(tracked.every(alive), "崩溃或自然退出前必须已创建真实的完整子孙树");
      if (crashed) {
        process.kill(job.pid, "SIGKILL");
        await until(() => !alive(job.pid) && !alive(fakePid));
        assert.ok(alive(stored.dshPid), "cmd/dsh 退出后仍必须保留可核实的宿主");
      }
      const done = json(t, repo, ["status", job.id, "--wait", "--timeout-ms", "15000"]);
      assert.equal(done.status, "failed");
      if (crashed) assert.match(done.error, /worker.*退出/);
      else assert.equal(json(t, repo, ["result", job.id]).exitCode, 3);
      await until(() => tracked.every((pid) => !alive(pid)), () => JSON.stringify(tracked.map((pid) => ({ pid, alive: alive(pid) }))));
    } finally {
      t.run(["cancel", job.id], { cwd: repo });
      for (const pid of tracked.reverse()) {
        try { if (alive(pid)) process.kill(pid, "SIGKILL"); } catch (err) { if (err.code !== "ESRCH") throw err; }
      }
    }
  });
}

test("宿主崩溃后整树结束，作业不带残留进程进入失败终态", async () => {
  const t = setup();
  const repo = makeGitRepo();
  const tree = path.join(repo, "host-crash-tree.jsonl");
  const job = json(t, repo, ["task", "--background", "等待时崩溃"], {
    FAKE_DSH_ORPHAN_TREE: tree, FAKE_DSH_DELAY_MS: "30000",
  });
  const tracked = [job.pid];
  try {
    await until(() => fs.existsSync(tree) && fs.readFileSync(tree, "utf8").trim().split("\n").length === 2);
    const stored = JSON.parse(fs.readFileSync(path.join(path.dirname(job.logPath), `${job.id}.json`), "utf8"));
    tracked.push(stored.dshPid, t.readRecord().pid, ...fs.readFileSync(tree, "utf8").trim().split("\n").map((line) => JSON.parse(line).pid));
    assert.ok(tracked.every(alive));
    process.kill(stored.dshPid, "SIGKILL");
    const done = json(t, repo, ["status", job.id, "--wait", "--timeout-ms", "15000"]);
    assert.equal(done.status, "failed");
    await until(() => tracked.every((pid) => !alive(pid)), () => JSON.stringify(tracked.map((pid) => ({ pid, alive: alive(pid) }))));
  } finally {
    t.run(["cancel", job.id], { cwd: repo });
    for (const pid of tracked.reverse()) {
      try { if (alive(pid)) process.kill(pid, "SIGKILL"); } catch (err) { if (err.code !== "ESRCH") throw err; }
    }
  }
});

test("Windows cancel 拒绝归属不匹配的存活 PID，恢复正确身份后仍可取消", { skip: process.platform !== "win32" }, async () => {
  const t = setup();
  const repo = makeGitRepo();
  const job = json(t, repo, ["task", "--background", "慢任务"], { FAKE_DSH_DELAY_MS: "30000" });
  const file = path.join(path.dirname(job.logPath), `${job.id}.json`);
  let original;
  try {
    await until(() => fs.existsSync(t.record));
    original = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(original.dshIdentity, "Windows 作业必须记录独立宿主身份");
    const stale = { ...original, dshIdentity: { ...original.dshIdentity, token: "00000000-0000-0000-0000-000000000000" } };
    // 模拟记录指向了其他作业的存活 PID；保留真实进程不动。
    fs.writeFileSync(file, JSON.stringify(stale));
    const rejected = t.run(["cancel", job.id], { cwd: repo });
    assert.equal(rejected.code, 1);
    assert.match(rejected.stderr, /归属不匹配/);
    assert.ok(alive(original.dshPid), "不能终止身份不匹配的宿主");
    assert.ok(alive(t.readRecord().pid), "不能终止该 PID 的后代");
    const current = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(current.status, "running");
    assert.ok(current.cancelRequestedAt, "失败的取消必须保留意图供重试");
    fs.writeFileSync(file, JSON.stringify({ ...current, dshIdentity: original.dshIdentity }));
    assert.equal(json(t, repo, ["cancel", job.id]).status, "cancelled");
    await until(() => !alive(t.readRecord().pid) && !alive(original.dshPid) && !alive(job.pid));
  } finally {
    if (original?.dshIdentity) {
      const current = JSON.parse(fs.readFileSync(file, "utf8"));
      fs.writeFileSync(file, JSON.stringify({ ...current, dshIdentity: original.dshIdentity }));
    }
    t.run(["cancel", job.id], { cwd: repo });
  }
});

for (const mode of ["no-final", "incomplete", "exit-nonzero", "error"]) {
  test(`失败作业 ${mode} 不把中间文本当作 final，也不替换最近已完成作业`, () => {
    const t = setup();
    const repo = makeGitRepo();
    const first = json(t, repo, ["task", "--background", "首次任务"]);
    assert.equal(json(t, repo, ["status", first.id, "--wait", "--timeout-ms", "15000"]).status, "completed");
    const second = json(t, repo, ["task", "--background", "失败任务"], { FAKE_DSH_MODE: mode });
    assert.equal(json(t, repo, ["status", second.id, "--wait", "--timeout-ms", "15000"]).status, "failed");
    const result = json(t, repo, ["result", second.id]);
    assert.equal(result.ok, false);
    if (mode === "no-final") assert.equal(result.final, null);
    assert.equal(json(t, repo, ["result"]).id, first.id);
  });
}

test("启动 dsh 失败会让作业进入失败终态", () => {
  const t = setup();
  const repo = makeGitRepo();
  const job = json(t, repo, ["task", "--background", "任务"], { DSH_BIN: path.join(repo, "missing-dsh") });
  const done = json(t, repo, ["status", job.id, "--wait", "--timeout-ms", "15000"]);
  assert.equal(done.status, "failed");
  assert.match(done.error, /DSH_BIN/);
});

test("result 默认选择最近完成的作业，而不是最近创建的作业", () => {
  const t = setup();
  const repo = makeGitRepo();
  const slow = json(t, repo, ["task", "--background", "慢任务"], { FAKE_DSH_DELAY_MS: "2500", FAKE_DSH_FINAL: "最后完成" });
  const fast = json(t, repo, ["task", "--background", "快任务"]);
  assert.equal(json(t, repo, ["status", fast.id, "--wait", "--timeout-ms", "15000"]).status, "completed");
  assert.equal(json(t, repo, ["status", slow.id, "--wait", "--timeout-ms", "15000"]).status, "completed");
  assert.equal(json(t, repo, ["result"]).final, "最后完成");
});

test("第 51 个作业删除最旧记录及日志，并发创建仍遵守每项目 50 个上限", async () => {
  const t = setup();
  const repo = makeGitRepo();
  json(t, repo, ["task-resume-candidate"]);
  const [project] = fs.readdirSync(t.data);
  const dir = path.join(t.data, project, "jobs");
  for (let i = 0; i < 50; i++) {
    const id = `old-${String(i).padStart(2, "0")}`;
    const at = new Date(Date.UTC(2020, 0, 1, 0, 0, i)).toISOString();
    const logPath = path.join(dir, `${id}.log`);
    fs.writeFileSync(logPath, "已有作业日志\n");
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, kind: "task", status: "completed", pid: null,
      createdAt: at, startedAt: at, finishedAt: at, claudeSessionId: null, logPath, result: { ok: true, final: "已有结果" } }));
  }
  const newJob = json(t, repo, ["task", "--background", "第 51 个作业"]);
  assert.equal(fs.existsSync(path.join(dir, "old-00.json")), false);
  assert.equal(fs.existsSync(path.join(dir, "old-00.log")), false);
  assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith(".json") && !name.endsWith(".request.json")).length, 50);
  assert.equal(json(t, repo, ["status", newJob.id, "--wait", "--timeout-ms", "15000"]).status, "completed");
  const calls = await Promise.all([1, 2].map((i) => t.runAsync(["task", "--background", "--json", `并发作业 ${i}`], { cwd: repo })));
  for (const call of calls) {
    assert.equal(call.code, 0, call.stderr);
    const job = JSON.parse(call.stdout);
    assert.equal(json(t, repo, ["status", job.id, "--wait", "--timeout-ms", "15000"]).status, "completed");
  }
  for (const id of ["old-01", "old-02"]) {
    assert.equal(fs.existsSync(path.join(dir, `${id}.json`)), false);
    assert.equal(fs.existsSync(path.join(dir, `${id}.log`)), false);
  }
  assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith(".json")).length, 50);
  assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith(".log")).length, 50);
});

test("后台任务续接绑定选定线程，模型覆盖失败不向日志和结果泄露配置", () => {
  const t = setup();
  const repo = makeGitRepo();
  assert.equal(t.run(["task", "首次任务"], { cwd: repo }).code, 0);
  const secret = "background-config-secret";
  const job = json(t, repo, ["task", "--background", "--resume", "--expected-thread-id", "thr_fake_1", "--model", "chosen", "任务"], {
    FAKE_DSH_MODE: "exit-nonzero", FAKE_DSH_ECHO_PATCH: "1",
    FAKE_DSH_CONFIG: `- id: agent-default-model\n  config:\n    model: old\n    apiKey: ${secret}\n`,
  });
  const status = json(t, repo, ["status", job.id, "--wait", "--timeout-ms", "15000"]);
  assert.equal(status.status, "failed");
  assert.ok(t.readRecord().argv.includes("thr_fake_1"));
  assert.equal(fs.existsSync(t.readRecord().patchPath), false);
  assert.doesNotMatch(fs.readFileSync(status.logPath, "utf8"), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(json(t, repo, ["result", job.id])), new RegExp(secret));
});

test("取消使用模型覆盖的作业时清理临时配置目录", async () => {
  const t = setup();
  const repo = makeGitRepo();
  const job = json(t, repo, ["task", "--background", "--model", "chosen", "任务"], { FAKE_DSH_DELAY_MS: "30000" });
  try {
    await until(() => fs.existsSync(t.record) && Boolean(t.readRecord().patchPath));
    const patch = t.readRecord().patchPath;
    assert.ok(fs.existsSync(patch));
    assert.equal(json(t, repo, ["cancel", job.id]).status, "cancelled");
    assert.equal(fs.existsSync(path.dirname(patch)), false);
  } finally { t.run(["cancel", job.id], { cwd: repo }); }
});

test("作业管理参数错误明确失败，编号不能越出项目目录", () => {
  const t = setup();
  const repo = makeGitRepo();
  for (const args of [["cancel"], ["status", "../outside"], ["status", "--wait", "--timeout-ms", "-1"], ["status", "--timeout-ms", "10"], ["result"]]) {
    const r = t.run(args, { cwd: repo });
    assert.notEqual(r.code, 0);
    assert.ok(r.stderr.trim());
  }
});

test("status/result/cancel 命令通过内联 Bash 执行 companion 并传入插件数据目录", () => {
  for (const command of ["status", "result", "cancel"]) {
    const text = fs.readFileSync(new URL(`../commands/${command}.md`, import.meta.url), "utf8");
    assert.match(text, /allowed-tools: Bash\(node:\*\)/);
    assert.match(text, new RegExp('!`CLAUDE_PLUGIN_DATA="\\$\\{CLAUDE_PLUGIN_DATA\\}" node "\\$\\{CLAUDE_PLUGIN_ROOT\\}/scripts/deepseek-companion.mjs" ' + command + ' \\$ARGUMENTS`'));
  }
  for (const filename of ["../commands/task.md", "../agents/deepseek-agent.md"]) {
    assert.match(fs.readFileSync(new URL(filename, import.meta.url), "utf8"), /--background/);
  }
});
