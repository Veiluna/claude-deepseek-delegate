import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { setup, makeGitRepo, tmpDir } from "./helpers.mjs";

test("任务成功后记录 sessionId，并从 final 提供上次任务摘要", () => {
  const t = setup();
  const repo = makeGitRepo();
  const task = t.run(["task", "--json", "补充测试"], {
    cwd: repo,
    env: { FAKE_DSH_THREAD_ID: "thr_saved", FAKE_DSH_FINAL: "完成：补充了续接测试。" },
  });
  assert.equal(task.code, 0, task.stderr);
  const candidate = t.run(["task-resume-candidate", "--json"], { cwd: repo });
  assert.equal(candidate.code, 0, candidate.stderr);
  assert.deepEqual(JSON.parse(candidate.stdout), {
    available: true,
    threadId: "thr_saved",
    summary: "完成：补充了续接测试。",
  });
});

test("--resume 与 --fresh 同时指定时拒绝执行且保留可续接线程", () => {
  const t = setup();
  const repo = makeGitRepo();
  assert.equal(t.run(["task", "首次任务"], { cwd: repo }).code, 0);
  const before = fs.readFileSync(t.record, "utf8");
  const candidate = t.run(["task-resume-candidate", "--json"], { cwd: repo });
  const r = t.run(["task", "--resume", "--fresh", "继续任务"], { cwd: repo });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--resume.*--fresh/);
  assert.equal(fs.readFileSync(t.record, "utf8"), before);
  assert.equal(t.run(["task-resume-candidate", "--json"], { cwd: repo }).stdout, candidate.stdout);
});

test("--fresh 新开线程，成功后替换可续接线程", () => {
  const t = setup();
  const repo = makeGitRepo();
  assert.equal(t.run(["task", "首次任务"], { cwd: repo }).code, 0);
  const r = t.run(["task", "--fresh", "新任务"], {
    cwd: repo,
    env: { FAKE_DSH_THREAD_ID: "thr_fresh", FAKE_DSH_FINAL: "完成：新任务" },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(t.readRecord().argv, ["--profile", "headless", "--json", "-"]);
  assert.ok(t.readRecord().stdin.startsWith("新任务\n"));
  const candidate = t.run(["task-resume-candidate", "--json"], { cwd: repo });
  assert.deepEqual(JSON.parse(candidate.stdout), {
    available: true, threadId: "thr_fresh", summary: "完成：新任务",
  });
});

test("可续接线程按项目隔离，--cwd 使用目标项目的 git 根目录", () => {
  const t = setup();
  const repo = makeGitRepo();
  const other = makeGitRepo();
  assert.equal(t.run(["task", "首次任务"], { cwd: repo }).code, 0);
  const candidate = t.run(["task-resume-candidate", "--json"], { cwd: other });
  assert.deepEqual(JSON.parse(candidate.stdout), { available: false, threadId: null, summary: null });
  const before = fs.readFileSync(t.record, "utf8");
  assert.equal(t.run(["task", "--resume", "继续任务"], { cwd: other }).code, 1);
  assert.equal(fs.readFileSync(t.record, "utf8"), before);
  const target = path.join(repo, "sub");
  const selected = t.run(["task-resume-candidate", "--cwd", target, "--json"], { cwd: other });
  assert.equal(JSON.parse(selected.stdout).threadId, "thr_fake_1");
  const resumed = t.run(["task", "--cwd", target, "--resume", "继续任务"], { cwd: other });
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(fs.realpathSync(t.readRecord().cwd), repo);
  assert.deepEqual(t.readRecord().argv, ["--profile", "headless", "--json", "--session-id", "thr_fake_1", "-"]);
});

test("没有 git 时按工作目录保存可续接线程", () => {
  const t = setup();
  const repo = makeGitRepo();
  const plain = tmpDir("ds-plain-");
  const first = t.run(["task", "--cwd", plain, "首次任务"], { cwd: repo });
  assert.equal(first.code, 0, first.stderr);
  const candidate = t.run(["task-resume-candidate", "--json"], { cwd: plain });
  assert.equal(JSON.parse(candidate.stdout).threadId, "thr_fake_1");
  const resumed = t.run(["task", "--resume", "继续任务"], { cwd: plain });
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(fs.realpathSync(t.readRecord().cwd), plain);
});

for (const mode of ["exit-nonzero", "error", "no-final", "incomplete", "missing-reason", "non-json"]) {
  test(`失败任务（${mode}）不创建或替换可续接线程`, () => {
    const t = setup();
    const repo = makeGitRepo();
    const env = { FAKE_DSH_MODE: mode, FAKE_DSH_THREAD_ID: "thr_failed", FAKE_DSH_FINAL: "不能保存的回复" };
    assert.equal(t.run(["task", "--fresh", "失败任务"], { cwd: repo, env }).code, 1);
    const empty = t.run(["task-resume-candidate", "--json"], { cwd: repo });
    assert.deepEqual(JSON.parse(empty.stdout), { available: false, threadId: null, summary: null });
    assert.equal(t.run(["task", "首次成功任务"], { cwd: repo }).code, 0);
    const before = t.run(["task-resume-candidate", "--json"], { cwd: repo });
    for (const route of ["--resume", "--fresh"]) {
      assert.equal(t.run(["task", route, "失败任务"], { cwd: repo, env }).code, 1);
      assert.equal(t.run(["task-resume-candidate", "--json"], { cwd: repo }).stdout, before.stdout);
    }
  });
}

test("成功任务缺少 session 事件时保留原可续接线程", () => {
  const t = setup();
  const repo = makeGitRepo();
  assert.equal(t.run(["task", "首次任务"], { cwd: repo }).code, 0);
  const before = t.run(["task-resume-candidate", "--json"], { cwd: repo });
  const r = t.run(["task", "--fresh", "新任务"], { cwd: repo, env: { FAKE_DSH_MODE: "no-session" } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(t.run(["task-resume-candidate", "--json"], { cwd: repo }).stdout, before.stdout);
});

test("摘要取自 final 的前 500 字符，完整最终回复保持不变", () => {
  const t = setup();
  const repo = makeGitRepo();
  const final = "最终回复".repeat(3000);
  const r = t.run(["task", "--json", "长回复任务"], { cwd: repo, env: { FAKE_DSH_FINAL: `  ${final}\n` } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).final, `  ${final}\n`);
  const candidate = t.run(["task-resume-candidate", "--json"], { cwd: repo });
  assert.equal(JSON.parse(candidate.stdout).summary, final.slice(0, 500));
});

test("setup 和候选查询不改变可续接线程", () => {
  const t = setup();
  const repo = makeGitRepo();
  assert.equal(t.run(["task", "首次任务"], { cwd: repo }).code, 0);
  const before = t.run(["task-resume-candidate", "--json"], { cwd: repo });
  const r = t.run(["setup", "--json"], { cwd: repo, env: { FAKE_DSH_THREAD_ID: "thr_setup", FAKE_DSH_FINAL: "OK" } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).ready, true);
  assert.equal(t.run(["task-resume-candidate", "--json"], { cwd: repo }).stdout, before.stdout);
});

test("没有可续接线程时明确报错且不启动 dsh", () => {
  const t = setup();
  const repo = makeGitRepo();
  const candidate = t.run(["task-resume-candidate", "--json"], { cwd: repo });
  assert.equal(candidate.code, 0, candidate.stderr);
  assert.deepEqual(JSON.parse(candidate.stdout), { available: false, threadId: null, summary: null });
  const r = t.run(["task", "--resume", "继续任务"], { cwd: repo });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /没有可续接线程/);
  assert.match(r.stderr, /--fresh/);
  assert.equal(fs.existsSync(t.record), false);
});

test("跨 Claude 会话续接同一项目的线程，权限按本次任务决定", () => {
  const t = setup();
  const repo = makeGitRepo();
  const first = t.run(["task", "实现功能"], {
    cwd: repo,
    env: { CLAUDE_SESSION_ID: "claude-a", FAKE_DSH_THREAD_ID: "thr_shared" },
  });
  assert.equal(first.code, 0, first.stderr);
  const candidate = t.run(["task-resume-candidate", "--json"], {
    cwd: path.join(repo, "sub"), env: { CLAUDE_SESSION_ID: "claude-b" },
  });
  assert.equal(candidate.code, 0, candidate.stderr);
  assert.equal(JSON.parse(candidate.stdout).threadId, "thr_shared");

  for (const [flags, permissionMode] of [[ ["--read-only"], "read-only" ], [ [], "workspace-write" ]]) {
    const r = t.run(["task", "--resume", ...flags, "继续任务"], {
      cwd: path.join(repo, "sub"),
      env: { CLAUDE_SESSION_ID: "claude-b", DSH_PERMISSION_MODE: "danger-full-access", FAKE_DSH_THREAD_ID: "thr_shared" },
    });
    assert.equal(r.code, 0, r.stderr);
    const record = t.readRecord();
    assert.deepEqual(record.argv, ["--profile", "headless", "--json", "--session-id", "thr_shared", "-"]);
    assert.equal(record.permissionMode, permissionMode);
    assert.equal(fs.realpathSync(record.cwd), repo);
    assert.ok(record.stdin.startsWith("继续任务"));
  }
});

test("确认期间候选被其他 Claude 会话替换时拒绝续接且不启动 dsh", () => {
  const t = setup();
  const repo = makeGitRepo();
  assert.equal(t.run(["task", "任务 X"], {
    cwd: repo, env: { CLAUDE_SESSION_ID: "claude-a", FAKE_DSH_THREAD_ID: "thr_x" },
  }).code, 0);
  const shown = JSON.parse(t.run(["task-resume-candidate", "--json"], { cwd: repo }).stdout);
  assert.equal(t.run(["task", "任务 Y"], {
    cwd: repo, env: { CLAUDE_SESSION_ID: "claude-b", FAKE_DSH_THREAD_ID: "thr_y" },
  }).code, 0);
  const before = fs.readFileSync(t.record, "utf8");
  const candidate = t.run(["task-resume-candidate", "--json"], { cwd: repo });
  const r = t.run(["task", "--resume", "--expected-thread-id", shown.threadId, "继续任务 X"], {
    cwd: repo, env: { CLAUDE_SESSION_ID: "claude-a" },
  });
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /可续接线程已变化/);
  assert.equal(fs.readFileSync(t.record, "utf8"), before);
  assert.equal(t.run(["task-resume-candidate", "--json"], { cwd: repo }).stdout, candidate.stdout);
});

test("候选未变化时续接确认的线程，预期线程 ID 不进入任务正文或 dsh 参数", () => {
  const t = setup();
  const repo = makeGitRepo();
  assert.equal(t.run(["task", "首次任务"], { cwd: repo }).code, 0);
  const candidate = JSON.parse(t.run(["task-resume-candidate", "--json"], { cwd: repo }).stdout);
  const r = t.run(["task", "--resume", "--expected-thread-id", candidate.threadId, "--read-only", "--", "继续任务"], { cwd: repo });
  assert.equal(r.code, 0, r.stderr);
  const record = t.readRecord();
  assert.deepEqual(record.argv, ["--profile", "headless", "--json", "--session-id", candidate.threadId, "-"]);
  assert.equal(record.permissionMode, "read-only");
  assert.ok(record.stdin.startsWith("继续任务\n"));
  assert.doesNotMatch(record.stdin, /thr_fake_1|--expected-thread-id/);
});

test("预期线程 ID 必须与 --resume 配合且不能为空", () => {
  const t = setup();
  const repo = makeGitRepo();
  for (const flags of [
    ["--expected-thread-id", "thr_x"],
    ["--fresh", "--expected-thread-id", "thr_x"],
    ["--resume", "--expected-thread-id", ""],
    ["--resume", "--expected-thread-id"],
  ]) {
    const r = t.run(["task", "继续任务", ...flags], { cwd: repo });
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /--expected-thread-id/);
    assert.equal(fs.existsSync(t.record), false);
  }
});

test("并行任务原子替换候选，最终状态保持完整", async () => {
  const t = setup();
  const repo = makeGitRepo();
  assert.equal(t.run(["task", "首次任务"], { cwd: repo }).code, 0);
  const [project] = fs.readdirSync(t.data);
  const statePath = path.join(t.data, project, "state.json");
  const before = fs.readFileSync(statePath, "utf8");
  // Windows can deny replacement while this handle stays open; exercise that separately with a short-lived reader.
  const snapshot = process.platform === "win32" ? null : fs.openSync(statePath, "r");
  const candidates = [
    { available: true, threadId: "thr_parallel_a", summary: "甲".repeat(500) },
    { available: true, threadId: "thr_parallel_b", summary: "乙".repeat(30) },
  ];
  try {
    const results = await Promise.all(candidates.map((candidate, i) => t.runAsync(["task", "--fresh", "并行任务"], {
      cwd: repo,
      env: {
        CLAUDE_SESSION_ID: `claude-${i}`,
        FAKE_DSH_THREAD_ID: candidate.threadId,
        FAKE_DSH_FINAL: candidate.summary,
        FAKE_DSH_RECORD: path.join(path.dirname(t.record), `record-${i}.json`),
      },
    })));
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    // Published state is replaced, so a reader holding the previous file still sees that complete snapshot.
    if (snapshot !== null) assert.equal(fs.readFileSync(snapshot, "utf8"), before);
    const result = t.run(["task-resume-candidate", "--json"], { cwd: repo });
    assert.equal(result.code, 0, result.stderr);
    const candidate = JSON.parse(result.stdout);
    assert.ok(candidates.some((expected) => JSON.stringify(expected) === JSON.stringify(candidate)), result.stdout);
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(statePath, "utf8")));
    assert.deepEqual(fs.readdirSync(path.dirname(statePath)).sort(), ["jobs", "state.json"]);
  } finally {
    if (snapshot !== null) fs.closeSync(snapshot);
  }
});

test("Windows 读句柄短暂占用时等待释放再保存候选", { skip: process.platform !== "win32" }, async () => {
  const t = setup();
  const repo = makeGitRepo();
  assert.equal(t.run(["task", "首次任务"], { cwd: repo }).code, 0);
  const [project] = fs.readdirSync(t.data);
  const directory = path.join(t.data, project);
  const statePath = path.join(directory, "state.json");
  const before = fs.readFileSync(statePath, "utf8");
  const reader = fs.openSync(statePath, "r");
  let settled = false;
  const pending = t.runAsync(["task", "--fresh", "更新任务"], {
    cwd: repo,
    env: { FAKE_DSH_THREAD_ID: "thr_after_reader", FAKE_DSH_FINAL: "读句柄释放后完成" },
  }).then((result) => ({ result }), (error) => ({ error })).then((completion) => {
    settled = true;
    return completion;
  });
  let completion;
  try {
    // Wait for a staged write instead of assuming the child has started within a fixed delay.
    const deadline = Date.now() + 10000;
    while (!fs.readdirSync(directory).some((name) => name.endsWith(".tmp"))) {
      assert.equal(settled, false, "读句柄释放前保存任务已经结束");
      assert.ok(Date.now() < deadline, "等待保存任务写入临时文件超时");
      await delay(10);
    }
    await delay(150);
    assert.equal(settled, false, "应等待短暂占用解除，而不是因 rename 失败而退出");
    assert.equal(fs.readFileSync(statePath, "utf8"), before);
    assert.equal(fs.readFileSync(reader, "utf8"), before);
  } finally {
    fs.closeSync(reader);
    completion = await pending;
  }
  assert.ifError(completion.error);
  assert.equal(completion.result.code, 0, completion.result.stderr);
  const candidate = t.run(["task-resume-candidate", "--json"], { cwd: repo });
  assert.equal(candidate.code, 0, candidate.stderr);
  assert.deepEqual(JSON.parse(candidate.stdout), {
    available: true, threadId: "thr_after_reader", summary: "读句柄释放后完成",
  });
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(statePath, "utf8")));
  assert.deepEqual(fs.readdirSync(directory).sort(), ["jobs", "state.json"]);
});

test("状态 JSON 损坏时查询和 --resume 明确失败且不启动 dsh", () => {
  const t = setup();
  const repo = makeGitRepo();
  assert.equal(t.run(["task", "首次任务"], { cwd: repo }).code, 0);
  const [project] = fs.readdirSync(t.data);
  const statePath = path.join(t.data, project, "state.json");
  const damaged = '{"resumableThread": invalid-state-secret-marker}';
  fs.writeFileSync(statePath, damaged);
  const before = fs.readFileSync(t.record, "utf8");
  for (const args of [["task-resume-candidate", "--json"], ["task", "--resume", "继续任务"]]) {
    const r = t.run(args, { cwd: repo });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /状态文件.*损坏/);
    assert.doesNotMatch(r.stderr, /invalid-state-secret-marker|SyntaxError|没有可续接线程/);
    assert.equal(fs.readFileSync(t.record, "utf8"), before);
    assert.equal(fs.readFileSync(statePath, "utf8"), damaged);
  }
});

test("插件数据目录不可用时查询和 --resume 明确失败且不启动 dsh", () => {
  const t = setup();
  const repo = makeGitRepo();
  fs.writeFileSync(t.data, "不是目录");
  for (const args of [["task-resume-candidate", "--json"], ["task", "--resume", "继续任务"]]) {
    const r = t.run(args, { cwd: repo });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /读取项目状态失败/);
    assert.doesNotMatch(r.stderr, /没有可续接线程/);
    assert.equal(fs.existsSync(t.record), false);
    assert.equal(fs.readFileSync(t.data, "utf8"), "不是目录");
  }
});

test("状态结构无效时不得把损坏记录当作空候选", () => {
  const t = setup();
  const repo = makeGitRepo();
  assert.equal(t.run(["task", "首次任务"], { cwd: repo }).code, 0);
  const [project] = fs.readdirSync(t.data);
  const statePath = path.join(t.data, project, "state.json");
  const before = fs.readFileSync(t.record, "utf8");
  for (const state of [null, [], { resumableThread: { threadId: 42, summary: "摘要" } }, { resumableThread: { threadId: "thr_x", summary: 42 } }]) {
    const content = JSON.stringify(state);
    fs.writeFileSync(statePath, content);
    for (const args of [["task-resume-candidate", "--json"], ["task", "--resume", "继续任务"]]) {
      const r = t.run(args, { cwd: repo });
      assert.equal(r.code, 1);
      assert.equal(r.stdout, "");
      assert.match(r.stderr, /状态文件.*损坏/);
      assert.equal(fs.readFileSync(t.record, "utf8"), before);
      assert.equal(fs.readFileSync(statePath, "utf8"), content);
    }
  }
});

for (const json of [false, true]) {
  test(`插件数据目录不可写时保留已完成任务结果并报告保存警告（${json ? "JSON" : "文本"}）`, () => {
    const t = setup();
    const repo = makeGitRepo();
    fs.writeFileSync(t.data, "不是目录");
    const r = t.run(["task", "--fresh", ...(json ? ["--json"] : []), "完成任务"], {
      cwd: repo,
      env: { FAKE_DSH_THREAD_ID: "thr_unsaved", FAKE_DSH_FINAL: "完成：结果必须保留" },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /警告：可续接线程未能保存/);
    assert.match(r.stderr, /thr_unsaved/);
    assert.doesNotMatch(r.stderr, /DeepSeek 任务失败|Unhandled/);
    if (json) {
      const result = JSON.parse(r.stdout);
      assert.equal(result.ok, true);
      assert.equal(result.threadId, "thr_unsaved");
      assert.equal(result.final, "完成：结果必须保留");
      assert.equal(result.reason, "completed");
      assert.equal(result.exitCode, 0);
      assert.equal(result.error, null);
      assert.equal(result.resumableThreadSaved, false);
      assert.equal(result.warnings.length, 1);
      assert.match(result.warnings[0], /可续接线程未能保存/);
    } else {
      assert.equal(r.stdout, "完成：结果必须保留\n");
    }
    assert.equal(fs.readFileSync(t.data, "utf8"), "不是目录");
    assert.ok(t.readRecord().stdin.startsWith("完成任务\n"));
  });
}

test("成功任务不能覆盖损坏状态，仍返回结果并报告保存警告", () => {
  const t = setup();
  const repo = makeGitRepo();
  assert.equal(t.run(["task", "首次任务"], { cwd: repo }).code, 0);
  const [project] = fs.readdirSync(t.data);
  const statePath = path.join(t.data, project, "state.json");
  const damaged = '{"resumableThread": invalid-state-secret-marker}';
  fs.writeFileSync(statePath, damaged);
  const r = t.run(["task", "--fresh", "--json", "新任务"], {
    cwd: repo, env: { FAKE_DSH_THREAD_ID: "thr_unsaved", FAKE_DSH_FINAL: "任务已完成" },
  });
  assert.equal(r.code, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.final, "任务已完成");
  assert.equal(result.threadId, "thr_unsaved");
  assert.equal(result.resumableThreadSaved, false);
  assert.match(r.stderr, /可续接线程未能保存/);
  assert.doesNotMatch(r.stdout + r.stderr, /invalid-state-secret-marker|SyntaxError/);
  assert.equal(fs.readFileSync(statePath, "utf8"), damaged);
});

test("Windows 占用超过重试上限仍返回已完成任务结果并保留旧候选", { skip: process.platform !== "win32" }, async () => {
  const t = setup();
  const repo = makeGitRepo();
  assert.equal(t.run(["task", "首次任务"], { cwd: repo }).code, 0);
  const [project] = fs.readdirSync(t.data);
  const directory = path.join(t.data, project);
  const statePath = path.join(directory, "state.json");
  const before = fs.readFileSync(statePath, "utf8");
  const reader = fs.openSync(statePath, "r");
  let r;
  try {
    r = await t.runAsync(["task", "--fresh", "--json", "新任务"], {
      cwd: repo, env: { FAKE_DSH_THREAD_ID: "thr_busy", FAKE_DSH_FINAL: "任务已完成但状态被占用" },
    });
    assert.equal(fs.readFileSync(statePath, "utf8"), before);
  } finally {
    fs.closeSync(reader);
  }
  assert.equal(r.code, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.final, "任务已完成但状态被占用");
  assert.equal(result.threadId, "thr_busy");
  assert.equal(result.resumableThreadSaved, false);
  assert.match(r.stderr, /可续接线程未能保存/);
  const candidate = t.run(["task-resume-candidate", "--json"], { cwd: repo });
  assert.equal(candidate.code, 0, candidate.stderr);
  assert.equal(JSON.parse(candidate.stdout).threadId, "thr_fake_1");
  assert.deepEqual(fs.readdirSync(directory).sort(), ["jobs", "state.json"]);
});
