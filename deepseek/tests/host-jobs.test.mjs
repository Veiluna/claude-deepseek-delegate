import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { setup, makeGitRepo } from "./helpers.mjs";

const entry = fileURLToPath(new URL("../scripts/deepseek-host.mjs", import.meta.url));
export function fixture(t) {
  const f = setup();
  const cwd = makeGitRepo();
  const shared = path.join(path.dirname(f.data), "shared");
  const env = { ...process.env, DEEPSEEK_DATA_DIR: shared, DSH_BIN: f.bin,
    FAKE_DSH_RECORD: f.record, GIT_CEILING_DIRECTORIES: fs.realpathSync(os.tmpdir()) };
  const argumentsFor = (host, id, args, extra) => [...(extra.nodeArgs || []), entry, host, ...(id ? ["--session-id", id] : []), ...args];
  const run = (host, id, args, extra = {}) => {
    const r = spawnSync(process.execPath, argumentsFor(host, id, args, extra), {
      cwd: extra.cwd || cwd, encoding: "utf8", env: { ...env, ...extra.env }, input: extra.input,
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const runAsync = (host, id, args, extra = {}) => {
    const child = spawn(process.execPath, argumentsFor(host, id, args, extra), {
      cwd: extra.cwd || cwd, env: { ...env, ...extra.env }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", value => { stdout += value; });
    child.stderr.on("data", value => { stderr += value; });
    child.stdin.end(extra.input);
    const done = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr })); });
    return { child, done };
  };
  const seed = (id, owner = {}, status = "completed", at = "2026-01-01T00:00:00.000Z") => {
    if (!fs.existsSync(path.join(shared, "projects"))) assert.equal(run("codex", "same", ["task-resume-candidate", "--json"]).code, 0);
    const project = fs.readdirSync(path.join(shared, "projects"))[0];
    const dir = path.join(shared, "projects", project, "jobs");
    const job = { id, kind: "task", status, pid: null, dshPid: null, createdAt: at,
      startedAt: at, finishedAt: status === "completed" ? at : null, workspaceRoot: cwd,
      logPath: path.join(dir, `${id}.log`), result: { ok: true, final: id }, ...owner };
    const file = path.join(dir, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify(job));
    fs.writeFileSync(path.join(dir, `${id}.log`), id);
    return { file, job, dir };
  };
  t.after(() => {
    for (const target of [path.dirname(f.data), cwd]) fs.rmSync(target, { recursive: true, force: true });
  });
  return { ...f, cwd, shared, env, run, runAsync, seed };
}

function start(f, host = "codex", id = "same", extra = {}) {
  return f.run(host, null, ["session"], { ...extra, input: JSON.stringify({
    hook_event_name: "SessionStart", session_id: id, cwd: extra.cwd || f.cwd, transcript_path: null,
  }) });
}

const controls = new URL("./host-jobs-control.mjs", import.meta.url).href;
const controlled = (clock) => ({ nodeArgs: ["--import", controls], env: { DEEPSEEK_TEST_CLOCK: clock } });
const ownerFiles = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? ownerFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]).filter(p => p.endsWith("session.json"));
const ownerRecord = f => JSON.parse(fs.readFileSync(ownerFiles(path.join(f.shared, "hosts"))[0], "utf8"));
const cleanup = (f, snapshot, extra = {}) => f.run(snapshot.host, null, ["session", "--cleanup"], { ...extra, input: JSON.stringify({
  hook_event_name: "SessionEnd", session_id: snapshot.sessionId, cwd: f.cwd, before: Date.parse("2026-06-01T00:00:00.000Z"),
  snapshot: { host: snapshot.host, sessionId: snapshot.sessionId, fence: snapshot.lastSequence, roots: snapshot.workspaceRoots },
}) });

async function until(check) {
  const deadline = Date.now() + 20000;
  while (!check()) { assert.ok(Date.now() < deadline, "等待离线作业状态超时"); await delay(30); }
}

test("新宿主的默认列表、最近结果和显式编号按完整归属隔离，旧 Claude 字段不映射 Codex", (t) => {
  const f = fixture(t);
  f.seed("own", { host: "codex", sessionId: "same" });
  f.seed("claude", { host: "claude", sessionId: "same" }, "completed", "2026-01-02T00:00:00.000Z");
  f.seed("legacy", { claudeSessionId: "same" }, "completed", "2026-01-03T00:00:00.000Z");
  f.seed("unknown", { host: "codex", sessionId: null });
  const list = f.run("codex", "same", ["status", "--json"]);
  assert.equal(list.code, 0, list.stderr);
  assert.deepEqual(JSON.parse(list.stdout).map(j => j.id), ["own"]);
  assert.equal(JSON.parse(f.run("codex", "same", ["result", "--json"]).stdout).id, "own");
  assert.deepEqual(JSON.parse(f.run("claude", "same", ["status", "--json"]).stdout).map(j => j.id), ["claude", "legacy"]);
  assert.deepEqual(JSON.parse(f.run("codex", null, ["status", "--json"]).stdout), []);
  const all = f.run("codex", null, ["status", "--all", "--json"]);
  assert.equal(JSON.parse(all.stdout).length, 4);
  for (const command of ["status", "result", "cancel"]) {
    const denied = f.run("codex", "same", [command, "legacy", "--json"]);
    assert.equal(denied.code, 1, command);
    assert.equal(denied.stdout, "");
    assert.match(denied.stderr, /归属|所属/);
  }
});

test("未认领的记录在查询及取消前不会被恢复或读取日志", (t) => {
  const f = fixture(t);
  const foreign = f.seed("foreign", { host: "claude", sessionId: "same", logPath: f.cwd }, "running");
  const before = fs.readFileSync(foreign.file, "utf8");
  for (const command of ["status", "result", "cancel"]) {
    const denied = f.run("codex", "same", [command, "foreign", "--json"]);
    assert.equal(denied.code, 1);
    assert.match(denied.stderr, /归属|所属/);
    assert.equal(fs.readFileSync(foreign.file, "utf8"), before);
  }
});

test("Codex SessionStart 静默登记可空来源，不创建项目；恢复保留序号、项目集合及未知字段", (t) => {
  const f = fixture(t);
  const first = start(f);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stdout, "");
  assert.equal(first.stderr, "");
  assert.equal(fs.existsSync(path.join(f.shared, "projects")), false);
  const find = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? find(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  const file = find(path.join(f.shared, "hosts")).find(p => p.endsWith(".json"));
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(record.host, "codex");
  assert.equal(record.sessionId, "same");
  assert.equal(record.transcriptSource, null);
  assert.equal(record.lastSequence, 0);
  fs.writeFileSync(file, JSON.stringify({ ...record, lastSequence: 7, custom: { unknown: true } }));
  assert.equal(start(f).code, 0);
  const resumed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(resumed.lastSequence, 7);
  assert.deepEqual(resumed.workspaceRoots, [f.cwd]);
  assert.deepEqual(resumed.custom, { unknown: true });
  assert.equal(fs.existsSync(f.record), false);
});

test("两新宿主后台须已登记，缺失身份或subagent编号在淘汰、写作业及运行dsh前拒绝，前台仍可用", (t) => {
  const f = fixture(t);
  const envFile = path.join(f.cwd, "env.sh");
  assert.equal(start(f, "codex", "main").code, 0);
  for (const [host, id] of [["codex", null], ["codex", "child"], ["claude", "main"]]) {
    const denied = f.run(host, id, ["task", "--fresh", "--background", "--json", "不应运行"]);
    assert.equal(denied.code, 1, denied.stderr);
    assert.match(denied.stderr, /身份|登记/);
    assert.equal(fs.existsSync(f.record), false);
  }
  const before = fs.readdirSync(path.join(f.shared, "projects"), { recursive: true });
  assert.equal(before.some(p => /\.json$|\.log$/.test(p)), false);
  const foreground = f.run("codex", null, ["task", "--fresh", "--json", "前台"]);
  assert.equal(foreground.code, 0, foreground.stderr);
  const registered = start(f, "claude", "main", { env: { CLAUDE_ENV_FILE: envFile } });
  assert.equal(registered.code, 0, registered.stderr);
});

test("持久序号围栏保护同毫秒及时间回拨后的恢复新作业，旧helper只清固定上限", async (t) => {
  const f = fixture(t);
  assert.equal(start(f).code, 0);
  const launch = (clock) => {
    const r = f.run("codex", "same", ["task", "--fresh", "--background", "--json", "序号任务"], controlled(clock));
    assert.equal(r.code, 0, r.stderr);
    const job = JSON.parse(r.stdout);
    assert.ok(Number.isSafeInteger(job.ownerSequence) && job.ownerSequence > 0);
    return job;
  };
  const first = launch("2026-06-01T00:00:00.000Z");
  const snapshot = ownerRecord(f);
  assert.equal(snapshot.lastSequence, first.ownerSequence);
  assert.equal(start(f).code, 0);
  const sameTime = launch("2026-06-01T00:00:00.000Z");
  const backwards = launch("2025-01-01T00:00:00.000Z");
  assert.ok(backwards.ownerSequence > sameTime.ownerSequence && sameTime.ownerSequence > snapshot.lastSequence);
  const cleaned = cleanup(f, snapshot);
  assert.equal(cleaned.code, 0, cleaned.stderr);
  assert.equal(fs.existsSync(first.logPath), false);
  for (const job of [sameTime, backwards]) {
    const status = f.run("codex", "same", ["status", job.id, "--wait", "--timeout-ms", "15000", "--json"]);
    assert.equal(status.code, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).status, "completed");
    assert.ok(fs.existsSync(job.logPath));
  }
  const again = cleanup(f, snapshot);
  assert.equal(again.code, 0, again.stderr);
  assert.ok(fs.existsSync(sameTime.logPath));
});

test("序号或登记缺失损坏明确失败，新归属缺序号不会冒充legacy时间兼容", (t) => {
  const f = fixture(t);
  assert.equal(start(f).code, 0);
  const missing = f.seed("missing-sequence", { host: "codex", sessionId: "same" });
  const snapshot = ownerRecord(f);
  for (const value of [undefined, null, 0, -1, "1"]) {
    const job = { ...missing.job };
    if (value !== undefined) job.ownerSequence = value;
    fs.writeFileSync(missing.file, JSON.stringify(job));
    const r = cleanup(f, snapshot);
    assert.equal(r.code, 1, `sequence=${value}`);
    assert.match(r.stderr, /序号/);
    assert.ok(fs.existsSync(missing.job.logPath));
  }
  const owner = ownerFiles(path.join(f.shared, "hosts"))[0];
  for (const invalid of [{ ...snapshot, lastSequence: null }, { ...snapshot, lastSequence: undefined }, { ...snapshot, host: "claude" }]) {
    fs.writeFileSync(owner, JSON.stringify(invalid));
    const before = fs.readdirSync(missing.dir).sort();
    const denied = f.run("codex", "same", ["task", "--fresh", "--background", "--json", "不得执行"]);
    assert.equal(denied.code, 1);
    assert.match(denied.stderr, /登记/);
    assert.deepEqual(fs.readdirSync(missing.dir).sort(), before);
    assert.equal(fs.existsSync(f.record), false);
  }
});

test("跨项目预留尚未发布时End不等owner/jobs锁，快照roots包含该项目且新序号不被helper清理", async (t) => {
  const f = fixture(t);
  const other = makeGitRepo();
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  assert.equal(start(f).code, 0);
  const barrier = path.join(f.cwd, "publish");
  const pending = f.runAsync("codex", "same", ["task", "--fresh", "--background", "--json", "先预留"], {
    cwd: other, nodeArgs: ["--import", controls], env: { DEEPSEEK_TEST_PUBLICATION: barrier },
  });
  let launched;
  try {
    await until(() => fs.existsSync(barrier + ".ready"));
    const reserved = ownerRecord(f);
    assert.equal(reserved.lastSequence, 1);
    assert.ok(reserved.workspaceRoots.includes(other));
    const now = Date.now();
    const end = f.run("codex", null, ["session"], { input: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "same", cwd: f.cwd }) });
    assert.equal(end.code, 0, end.stderr);
    assert.equal(end.stdout, "");
    assert.ok(Date.now() - now < 2000, "End不得等待尚未发布记录持有的两把锁");
    fs.writeFileSync(barrier + ".release", "release");
    launched = await pending.done;
    assert.equal(launched.code, 0, launched.stderr);
    const first = JSON.parse(launched.stdout);
    const next = f.run("codex", "same", ["task", "--fresh", "--background", "--json", "恢复后新作业"]);
    assert.equal(next.code, 0, next.stderr);
    const job = JSON.parse(next.stdout);
    assert.ok(job.ownerSequence > reserved.lastSequence);
    await until(() => !fs.existsSync(first.logPath));
    const status = f.run("codex", "same", ["status", job.id, "--wait", "--timeout-ms", "15000", "--json"]);
    assert.equal(status.code, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).status, "completed");
  } finally {
    fs.writeFileSync(barrier + ".release", "release");
    if (!launched) { pending.child.kill(); await pending.done; }
  }
});

test("预留后companion崩溃留下序号空洞，锁恢复后后续作业不复用旧围栏", async (t) => {
  const f = fixture(t);
  assert.equal(start(f).code, 0);
  const barrier = path.join(f.cwd, "crash");
  const pending = f.runAsync("codex", "same", ["task", "--fresh", "--background", "--json", "崩溃前预留"], {
    nodeArgs: ["--import", controls], env: { DEEPSEEK_TEST_PUBLICATION: barrier },
  });
  t.after(() => { pending.child.kill(); });
  await until(() => fs.existsSync(barrier + ".ready"));
  const reserved = ownerRecord(f);
  pending.child.kill();
  await pending.done;
  const next = f.run("codex", "same", ["task", "--fresh", "--background", "--json", "崩溃后新作业"]);
  assert.equal(next.code, 0, next.stderr);
  const job = JSON.parse(next.stdout);
  assert.equal(job.ownerSequence, reserved.lastSequence + 1);
  assert.equal(cleanup(f, reserved).code, 0);
  const status = f.run("codex", "same", ["status", job.id, "--wait", "--timeout-ms", "15000", "--json"]);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).status, "completed");
});

test("两宿主合计50条且日志成对淘汰，未登记启动不改变已满项目", (t) => {
  const f = fixture(t);
  assert.equal(start(f).code, 0);
  let seeded;
  for (let i = 0; i < 50; i++) seeded = f.seed(`old-${String(i).padStart(2, "0")}`,
    { host: i % 2 ? "claude" : "codex", sessionId: "same", ownerSequence: i + 1 }, "completed", new Date(Date.UTC(2020, 0, 1, 0, 0, i)).toISOString());
  const before = fs.readdirSync(seeded.dir).sort();
  assert.equal(f.run("codex", "child", ["task", "--background", "--json", "不能淘汰"]).code, 1);
  assert.deepEqual(fs.readdirSync(seeded.dir).sort(), before);
  const launched = f.run("codex", "same", ["task", "--background", "--json", "第51条"]);
  assert.equal(launched.code, 0, launched.stderr);
  const job = JSON.parse(launched.stdout);
  assert.equal(f.run("codex", "same", ["status", job.id, "--wait", "--timeout-ms", "15000", "--json"]).code, 0);
  const files = fs.readdirSync(seeded.dir);
  assert.equal(files.filter(p => p.endsWith(".json") && !p.endsWith(".request.json")).length, 50);
  assert.equal(files.filter(p => p.endsWith(".log")).length, 50);
  assert.equal(files.includes("old-00.json"), false);
  assert.equal(files.includes("old-00.log"), false);
});

test("新宿主后台立即返回，status等待超时、cancel及result复用既有恢复路径", (t) => {
  const f = fixture(t);
  assert.equal(start(f).code, 0);
  const release = path.join(f.cwd, "release-dsh");
  const launched = f.run("codex", "same", ["task", "--background", "--json", "可取消"], { env: { FAKE_DSH_RELEASE_FILE: release } });
  assert.equal(launched.code, 0, launched.stderr);
  const job = JSON.parse(launched.stdout);
  try {
    assert.equal(fs.existsSync(release), false);
    const waiting = f.run("codex", "same", ["status", job.id, "--wait", "--timeout-ms", "0", "--json"]);
    assert.equal(waiting.code, 0, waiting.stderr);
    assert.equal(JSON.parse(waiting.stdout).timedOut, true);
    const cancelled = f.run("codex", "same", ["cancel", job.id, "--json"]);
    assert.equal(cancelled.code, 0, cancelled.stderr);
    assert.equal(JSON.parse(cancelled.stdout).status, "cancelled");
    const result = f.run("codex", "same", ["result", job.id, "--json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, false);
  } finally { fs.writeFileSync(release, "release"); }
  const orphan = f.seed("dead-worker", { host: "codex", sessionId: "same", ownerSequence: 99 }, "running");
  const recovered = f.run("codex", "same", ["status", "dead-worker", "--json"]);
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).status, "failed");
  assert.match(JSON.parse(fs.readFileSync(orphan.file, "utf8")).error, /worker 已退出/);
});

test("Stop等非结束事件及切换编号不清理，legacy时间兼容只作用Claude完整归属", (t) => {
  const f = fixture(t);
  assert.equal(start(f).code, 0);
  const own = f.seed("kept", { host: "codex", sessionId: "same", ownerSequence: 1 });
  const before = fs.readFileSync(own.file, "utf8");
  for (const hook_event_name of ["Stop", "TurnEnd", "SessionSwitch"]) {
    const r = f.run("codex", null, ["session"], { input: JSON.stringify({ hook_event_name, session_id: "same", cwd: f.cwd, transcript_path: null }) });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.equal(fs.readFileSync(own.file, "utf8"), before);
  }
  assert.equal(start(f, "codex", "other").code, 0);
  assert.equal(fs.readFileSync(own.file, "utf8"), before);
  assert.equal(start(f, "claude", "same", { env: { CLAUDE_ENV_FILE: path.join(f.cwd, "env.sh") } }).code, 0);
  const legacy = f.seed("legacy-claude", { claudeSessionId: "same" });
  const records = ownerFiles(path.join(f.shared, "hosts")).map(file => JSON.parse(fs.readFileSync(file, "utf8")));
  assert.equal(cleanup(f, records.find(r => r.host === "claude")).code, 0);
  assert.equal(fs.existsSync(legacy.file), false);
  assert.ok(fs.existsSync(own.file));
});

test("End先于序号提交及初始记录发布时，后续发布作业留在围栏之外", async (t) => {
  const f = fixture(t);
  assert.equal(start(f).code, 0);
  const barrier = path.join(f.cwd, "before-reservation");
  const pending = f.runAsync("codex", "same", ["task", "--fresh", "--background", "--json", "End之后发布"], {
    nodeArgs: ["--import", controls], env: { DEEPSEEK_TEST_RESERVATION: barrier },
  });
  let launched;
  try {
    await until(() => fs.existsSync(barrier + ".ready"));
    assert.equal(ownerRecord(f).lastSequence, 0);
    const ended = f.run("codex", null, ["session"], { input: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "same", cwd: f.cwd }) });
    assert.equal(ended.code, 0, ended.stderr);
    fs.writeFileSync(barrier + ".release", "release");
    launched = await pending.done;
    assert.equal(launched.code, 0, launched.stderr);
    const job = JSON.parse(launched.stdout);
    assert.equal(job.ownerSequence, 1);
    const status = f.run("codex", "same", ["status", job.id, "--wait", "--timeout-ms", "15000", "--json"]);
    assert.equal(status.code, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).status, "completed");
    assert.ok(fs.existsSync(job.logPath));
  } finally {
    fs.writeFileSync(barrier + ".release", "release");
    if (!launched) { pending.child.kill(); await pending.done; }
  }
});

test("两宿主真实后台同编号仍隔离，Codex真正End清理后Claude结果可用", async (t) => {
  const f = fixture(t);
  assert.equal(start(f).code, 0);
  assert.equal(start(f, "claude", "same", { env: { CLAUDE_ENV_FILE: path.join(f.cwd, "env.sh") } }).code, 0);
  const jobs = {};
  for (const host of ["codex", "claude"]) {
    const r = f.run(host, "same", ["task", "--background", "--json", "同编号作业"], { env: { FAKE_DSH_FINAL: host } });
    assert.equal(r.code, 0, r.stderr);
    jobs[host] = JSON.parse(r.stdout);
    assert.equal(jobs[host].host, host);
    assert.equal(jobs[host].ownerSequence, 1);
    assert.equal(f.run(host, "same", ["status", jobs[host].id, "--wait", "--timeout-ms", "15000", "--json"]).code, 0);
  }
  const end = f.run("codex", null, ["session"], { input: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "same", cwd: f.cwd }) });
  assert.equal(end.code, 0, end.stderr);
  await until(() => !fs.existsSync(jobs.codex.logPath));
  const result = f.run("claude", "same", ["result", "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).final, "claude");
  assert.ok(fs.existsSync(jobs.claude.logPath));
});
