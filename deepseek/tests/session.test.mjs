import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { setup, makeGitRepo } from "./helpers.mjs";
import { writeJsonAtomic } from "../scripts/lib/state.mjs";

const hook = fileURLToPath(new URL("../scripts/deepseek-session.mjs", import.meta.url));
test("插件只注册 SessionStart 与 SessionEnd，会话状态命令显式传递所属编号", () => {
  const config = JSON.parse(fs.readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(config.hooks).sort(), ["SessionEnd", "SessionStart"]);
  for (const event of Object.values(config.hooks)) {
    assert.equal(event.length, 1);
    assert.deepEqual(event[0].hooks, [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/deepseek-session.mjs"' }]);
  }
  const status = fs.readFileSync(new URL("../commands/status.md", import.meta.url), "utf8");
  assert.match(status, /CLAUDE_SESSION_ID="\$\{CLAUDE_SESSION_ID\}"/);
  assert.match(status, /--all/);
  assert.match(status, /当前 Claude 会话/);
});

function runHook(fixture, payload, extra = {}, args = []) {
  return spawnSync(process.execPath, [hook, ...args], {
    cwd: payload.cwd, input: JSON.stringify(payload), encoding: "utf8",
    env: { ...process.env, CLAUDE_PLUGIN_DATA: fixture.data,
      GIT_CEILING_DIRECTORIES: fs.realpathSync(os.tmpdir()), ...extra },
  });
}

function seedJob(fixture, cwd, id, claudeSessionId, at) {
  const init = fixture.run(["task-resume-candidate"], { cwd });
  assert.equal(init.code, 0, init.stderr);
  const directory = fs.readdirSync(fixture.data).find((entry) => entry.startsWith(path.basename(cwd) + "-"));
  const dir = path.join(fixture.data, directory, "jobs");
  const logPath = path.join(dir, `${id}.log`);
  fs.writeFileSync(logPath, `进度：${id}\n`);
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, kind: "task", status: "completed", pid: null,
    dshPid: null, claudeSessionId, workspaceRoot: cwd, createdAt: at, startedAt: at, finishedAt: at, logPath,
    result: { ok: true, final: id } }));
  return { dir, logPath };
}

async function until(check, describe = () => "") {
  const deadline = Date.now() + 15000;
  while (!check()) {
    assert.ok(Date.now() < deadline, `等待会话清理超时：${describe()}`);
    await delay(50);
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return process.platform !== "linux" || !fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1).startsWith("Z");
  } catch (error) { if (["ESRCH", "ENOENT"].includes(error.code)) return false; throw error; }
}

test("SessionStart 静默追加所属 Claude 会话与会话记录路径，环境文件可安全加载", () => {
  const fixture = setup();
  const cwd = makeGitRepo();
  const envFile = path.join(cwd, "claude env.sh");
  const sentinel = path.join(cwd, "不能执行").replaceAll("\\", "/");
  const session = "claude-'$`会话";
  const transcript = `${cwd}/记录 ' $(touch '${sentinel}') \`echo bad\` $.jsonl`;
  fs.writeFileSync(envFile, "export EXISTING_VARIABLE=preserved\n");
  const result = runHook(fixture, { hook_event_name: "SessionStart", session_id: session, transcript_path: transcript, cwd }, { CLAUDE_ENV_FILE: envFile });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.ok(fs.readFileSync(envFile, "utf8").startsWith("export EXISTING_VARIABLE=preserved\n"));
  const gitPath = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
  assert.equal(gitPath.status, 0, gitPath.stderr);
  const bash = process.platform === "win32" ? path.resolve(gitPath.stdout.trim(), "../../..", "bin/bash.exe") : "bash";
  const loaded = spawnSync(bash, ["--noprofile", "--norc", "-c", 'source "$1"; exec "$2" -e "$3"', "probe",
    envFile.replaceAll("\\", "/"), process.execPath.replaceAll("\\", "/"),
    "process.stdout.write(JSON.stringify([process.env.CLAUDE_SESSION_ID,process.env.CLAUDE_TRANSCRIPT_PATH,process.env.EXISTING_VARIABLE]))"],
  { encoding: "utf8", env: { ...process.env, BASH_ENV: "" } });
  assert.equal(loaded.status, 0, loaded.stderr || loaded.error?.message);
  assert.deepEqual(JSON.parse(loaded.stdout), [session, transcript, "preserved"]);
  assert.equal(fs.existsSync(sentinel), false);
  assert.equal(fs.existsSync(transcript), false, "登记路径不能读取或创建会话记录");
  assert.equal(fs.existsSync(fixture.record), false, "SessionStart 不能运行 dsh");
});

test("SessionEnd 保留无法确认进程身份的作业及取消意图，继续清理其他作业且不删除新作业", () => {
  const fixture = setup();
  const cwd = makeGitRepo();
  const unsafe = seedJob(fixture, cwd, "unsafe", "alpha", "2026-01-01T00:00:00.000Z");
  const unsafeFile = path.join(unsafe.dir, "unsafe.json");
  const record = JSON.parse(fs.readFileSync(unsafeFile, "utf8"));
  fs.writeFileSync(unsafeFile, JSON.stringify({ ...record, status: "running", pid: process.pid, finishedAt: null }));
  const done = seedJob(fixture, cwd, "done", "alpha", "2026-01-02T00:00:00.000Z");
  const future = seedJob(fixture, cwd, "future", "alpha", "2026-01-04T00:00:00.000Z");
  const ended = runHook(fixture, { hook_event_name: "SessionEnd", session_id: "alpha", cwd,
    before: Date.parse("2026-01-03T00:00:00.000Z") }, {}, ["--cleanup"]);
  assert.equal(ended.status, 1);
  assert.equal(ended.stdout, "");
  assert.match(ended.stderr, /会话钩子失败/);
  const retained = JSON.parse(fs.readFileSync(unsafeFile, "utf8"));
  assert.equal(retained.status, "running");
  assert.ok(retained.cancelRequestedAt);
  assert.match(retained.error, /进程身份/);
  assert.ok(alive(process.pid));
  assert.ok(fs.existsSync(unsafe.logPath));
  assert.equal(fs.existsSync(done.logPath), false);
  assert.equal(fs.existsSync(path.join(done.dir, "done.json")), false);
  assert.ok(fs.existsSync(future.logPath));
  assert.ok(fs.existsSync(path.join(future.dir, "future.json")));
});

test("无效钩子输入不会写入环境文件或启动无归属清理，也不回显敏感输入", () => {
  const fixture = setup();
  const cwd = makeGitRepo();
  const kept = seedJob(fixture, cwd, "kept", "alpha", "2026-01-01T00:00:00.000Z");
  const envFile = path.join(cwd, "env.sh");
  fs.writeFileSync(envFile, "existing\n");
  const secret = "sensitive-token-do-not-echo";
  for (const payload of [
    { hook_event_name: "SessionEnd", cwd, token: secret },
    { hook_event_name: "SessionStart", session_id: "alpha", cwd, token: secret },
    { hook_event_name: "SessionEnd", session_id: "", cwd, token: secret },
    { hook_event_name: "Stop", session_id: "alpha", cwd, token: secret },
  ]) {
    const failed = runHook(fixture, payload, { CLAUDE_ENV_FILE: envFile });
    assert.equal(failed.status, 1);
    assert.equal(failed.stdout, "");
    assert.doesNotMatch(failed.stderr, new RegExp(secret));
    assert.ok(fs.existsSync(kept.logPath));
    assert.ok(fs.existsSync(path.join(kept.dir, "kept.json")));
    assert.equal(fs.readFileSync(envFile, "utf8"), "existing\n");
  }
});

test("status 默认列出当前 Claude 会话的全部作业，不展示其他会话或无归属作业", () => {
  const fixture = setup();
  const cwd = makeGitRepo();
  seedJob(fixture, cwd, "alpha-first", "alpha", "2026-01-01T00:00:00.000Z");
  seedJob(fixture, cwd, "alpha-second", "alpha", "2026-01-02T00:00:00.000Z");
  seedJob(fixture, cwd, "beta-latest", "beta", "2026-01-03T00:00:00.000Z");
  seedJob(fixture, cwd, "unowned", null, "2026-01-04T00:00:00.000Z");
  const result = fixture.run(["status", "--json"], { cwd, env: { CLAUDE_SESSION_ID: "alpha" } });
  assert.equal(result.code, 0, result.stderr);
  const jobs = JSON.parse(result.stdout);
  assert.ok(Array.isArray(jobs), "不带编号时应列出作业列表");
  assert.deepEqual(jobs.map((job) => job.id), ["alpha-first", "alpha-second"]);
  assert.ok(jobs.every((job) => job.kind === "task" && job.status === "completed" && job.elapsedMs === 0 && job.progress.length === 1));
  const text = fixture.run(["status"], { cwd, env: { CLAUDE_SESSION_ID: "alpha" } });
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /alpha-first/);
  assert.match(text.stdout, /alpha-second/);
  assert.doesNotMatch(text.stdout, /beta-latest|unowned/);
});

test("status --all 查看项目全部作业，显式编号默认也核对 Claude 会话归属", () => {
  const fixture = setup();
  const cwd = makeGitRepo();
  const other = makeGitRepo();
  seedJob(fixture, cwd, "own", "alpha", "2026-01-01T00:00:00.000Z");
  seedJob(fixture, cwd, "foreign", "beta", "2026-01-02T00:00:00.000Z");
  seedJob(fixture, cwd, "unassigned", null, "2026-01-03T00:00:00.000Z");
  seedJob(fixture, other, "other-project", "alpha", "2026-01-04T00:00:00.000Z");
  const options = { cwd, env: { CLAUDE_SESSION_ID: "alpha" } };
  const all = fixture.run(["status", "--all", "--json"], options);
  assert.equal(all.code, 0, all.stderr);
  assert.deepEqual(JSON.parse(all.stdout).map((job) => job.id), ["own", "foreign", "unassigned"]);
  const denied = fixture.run(["status", "foreign", "--json"], options);
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /Claude 会话/);
  assert.equal(denied.stdout, "");
  const foreign = fixture.run(["status", "foreign", "--all", "--json"], options);
  assert.equal(foreign.code, 0, foreign.stderr);
  assert.equal(JSON.parse(foreign.stdout).id, "foreign");
  const empty = fixture.run(["status", "--json"], { cwd, env: { CLAUDE_SESSION_ID: "no-jobs" } });
  assert.equal(empty.code, 0, empty.stderr);
  assert.deepEqual(JSON.parse(empty.stdout), []);
});

test("status 列表等待本 Claude 会话全部作业，超时标记运行项且不恢复其他会话", async () => {
  const fixture = setup();
  const cwd = makeGitRepo();
  const seeded = ["first", "second", "foreign"].map((id) => {
    const { dir } = seedJob(fixture, cwd, id, id === "foreign" ? "beta" : "alpha", "2026-01-01T00:00:00.000Z");
    const file = path.join(dir, `${id}.json`);
    const record = { ...JSON.parse(fs.readFileSync(file, "utf8")), status: "running", pid: process.pid, finishedAt: null };
    fs.writeFileSync(file, JSON.stringify(record));
    return { file, record };
  });
  const options = { cwd, env: { CLAUDE_SESSION_ID: "alpha" } };
  const timed = fixture.run(["status", "--wait", "--timeout-ms", "20", "--json"], options);
  assert.equal(timed.code, 0, timed.stderr);
  const waiting = JSON.parse(timed.stdout);
  assert.deepEqual(waiting.map((job) => job.id), ["first", "second"]);
  assert.ok(waiting.every((job) => job.status === "running" && job.timedOut));
  const pending = fixture.runAsync(["status", "--wait", "--timeout-ms", "5000", "--json"], options);
  for (const { file, record } of seeded.slice(0, 2)) {
    await delay(200);
    await writeJsonAtomic(file, { ...record, status: "completed", finishedAt: new Date().toISOString() });
  }
  const completed = await pending;
  assert.equal(completed.code, 0, completed.stderr);
  const jobs = JSON.parse(completed.stdout);
  assert.deepEqual(jobs.map((job) => job.id), ["first", "second"]);
  assert.ok(jobs.every((job) => job.status === "completed" && !job.timedOut));
  assert.deepEqual(JSON.parse(fs.readFileSync(seeded[2].file, "utf8")), seeded[2].record);
});

test("SessionEnd 快速返回并删除本 Claude 会话跨项目的终态作业，保留其他归属", async () => {
  const fixture = setup();
  const cwd = makeGitRepo();
  const other = makeGitRepo();
  const own = seedJob(fixture, cwd, "own", "alpha", "2026-01-01T00:00:00.000Z");
  const elsewhere = seedJob(fixture, other, "elsewhere", "alpha", "2026-01-01T00:00:00.000Z");
  seedJob(fixture, cwd, "foreign", "beta", "2026-01-01T00:00:00.000Z");
  seedJob(fixture, cwd, "unassigned", null, "2026-01-01T00:00:00.000Z");
  const preserved = ["foreign.json", "foreign.log", "unassigned.json", "unassigned.log"].map((name) => [name, fs.readFileSync(path.join(own.dir, name), "utf8")]);
  const started = Date.now();
  const result = runHook(fixture, { hook_event_name: "SessionEnd", session_id: "alpha", cwd,
    transcript_path: path.join(cwd, "missing-transcript.jsonl"), reason: "clear" }, { CLAUDE_SESSION_ID: "beta" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.ok(Date.now() - started < 1500, "分离清理不能占用 SessionEnd 的默认退出预算");
  await until(() => !fs.existsSync(own.logPath) && !fs.existsSync(elsewhere.logPath) &&
    !fs.existsSync(path.join(own.dir, "own.json")) && !fs.existsSync(path.join(elsewhere.dir, "elsewhere.json")));
  assert.equal(fs.existsSync(path.join(own.dir, "own.json")), false);
  assert.equal(fs.existsSync(path.join(elsewhere.dir, "elsewhere.json")), false);
  for (const [name, content] of preserved) assert.equal(fs.readFileSync(path.join(own.dir, name), "utf8"), content);
  const again = runHook(fixture, { hook_event_name: "SessionEnd", session_id: "alpha", cwd, reason: "other" });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout, "");
});

test("SessionEnd 清理本 Claude 会话运行中与排队作业的整树，其他会话仍能取回结果", async () => {
  const fixture = setup();
  const cwd = makeGitRepo();
  const other = makeGitRepo();
  const tree = path.join(cwd, "tree.jsonl");
  const query = (args, root, session, env = {}) => {
    const result = fixture.run([...args, "--json"], { cwd: root, env: { CLAUDE_SESSION_ID: session, ...env } });
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const recordA = path.join(cwd, "alpha-record.json");
  const recordB = path.join(cwd, "beta-record.json");
  const recordOther = path.join(other, "alpha-record.json");
  const alpha = query(["task", "--background", "本会话慢任务"], cwd, "alpha", { FAKE_DSH_DELAY_MS: "30000", FAKE_DSH_TREE: tree, FAKE_DSH_RECORD: recordA });
  const beta = query(["task", "--background", "其他会话任务"], cwd, "beta", { FAKE_DSH_DELAY_MS: "30000", FAKE_DSH_RECORD: recordB });
  const elsewhere = query(["task", "--background", "另一个项目任务"], other, "alpha", { FAKE_DSH_DELAY_MS: "30000", FAKE_DSH_RECORD: recordOther });
  const queued = seedJob(fixture, cwd, "queued", "alpha", "2026-01-01T00:00:00.000Z");
  const queuedFile = path.join(queued.dir, "queued.json");
  const queuedJob = JSON.parse(fs.readFileSync(queuedFile, "utf8"));
  fs.writeFileSync(queuedFile, JSON.stringify({ ...queuedJob, status: "queued", finishedAt: null }));
  fs.writeFileSync(path.join(queued.dir, "queued.request.json"), "{}");
  const tracked = [alpha.pid, elsewhere.pid];
  try {
    await until(() => [recordA, recordB, recordOther, tree].every((file) => fs.existsSync(file)) && fs.readFileSync(tree, "utf8").trim().split("\n").length === 2);
    const a = query(["status", alpha.id], cwd, "alpha");
    const e = query(["status", elsewhere.id], other, "alpha");
    const betaBefore = query(["status", beta.id], cwd, "beta");
    tracked.push(a.dshPid, e.dshPid, JSON.parse(fs.readFileSync(recordA)).pid, JSON.parse(fs.readFileSync(recordOther)).pid,
      ...fs.readFileSync(tree, "utf8").trim().split("\n").map((line) => JSON.parse(line).pid));
    assert.ok(tracked.every(alive));
    const started = Date.now();
    const ended = runHook(fixture, { hook_event_name: "SessionEnd", session_id: "alpha", cwd, reason: "prompt_input_exit" });
    assert.equal(ended.status, 0, ended.stderr);
    assert.equal(ended.stdout, "");
    assert.ok(Date.now() - started < 1500);
    const deleted = [alpha, elsewhere].flatMap((job) => [job.logPath, path.join(path.dirname(job.logPath), `${job.id}.json`)]).concat(queuedFile, queued.logPath, path.join(queued.dir, "queued.request.json"));
    await until(() => deleted.every((file) => !fs.existsSync(file)) && tracked.every((pid) => !alive(pid)),
      () => JSON.stringify({ remainingFiles: deleted.filter(fs.existsSync), pids: tracked.map((pid) => ({ pid, alive: alive(pid) })) }));
    const betaAfter = query(["status", beta.id], cwd, "beta");
    assert.equal(betaBefore.status, "running");
    assert.equal(betaAfter.status, "running");
    assert.ok(alive(betaAfter.pid) && alive(betaAfter.dshPid) && fs.existsSync(betaAfter.logPath));
    assert.equal(query(["status", beta.id, "--wait", "--timeout-ms", "40000"], cwd, "beta").status, "completed");
    assert.equal(query(["result", beta.id], cwd, "beta").final, "完成：已处理任务");
  } finally {
    for (const [job, root] of [[alpha, cwd], [elsewhere, other], [beta, cwd]]) fixture.run(["cancel", job.id], { cwd: root });
    for (const pid of tracked.reverse()) { try { if (alive(pid)) process.kill(pid, "SIGKILL"); } catch (err) { if (err.code !== "ESRCH") throw err; } }
  }
});
