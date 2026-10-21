import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { setup, makeGitRepo, COMPANION } from "./helpers.mjs";

const entry = fileURLToPath(new URL("../scripts/deepseek-host.mjs", import.meta.url));
function fixture() {
  const t = setup();
  const cwd = makeGitRepo();
  const shared = path.join(path.dirname(t.data), "shared");
  const home = path.join(path.dirname(t.data), "home");
  fs.mkdirSync(home);
  const run = (host, args, extra = {}) => {
    const r = spawnSync(process.execPath, [entry, host, ...args], { cwd, encoding: "utf8", env: {
      ...process.env, HOME: home, USERPROFILE: home, DEEPSEEK_DATA_DIR: shared,
      CLAUDE_PLUGIN_DATA: t.data, CLAUDE_SESSION_ID: "inherited-claude", CLAUDE_TRANSCRIPT_PATH: "inherited.jsonl",
      CODEX_THREAD_ID: "inherited-codex", DSH_BIN: t.bin, FAKE_DSH_RECORD: t.record,
      GIT_CEILING_DIRECTORIES: fs.realpathSync(os.tmpdir()), ...extra,
    } });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return { ...t, cwd, shared, home, run };
}

test("显式 Claude 与 Codex 入口共享候选，候选变化时不执行任务", () => {
  const f = fixture();
  const started = f.run("claude", ["task", "--fresh", "--json", "首次任务"]);
  assert.equal(started.code, 0, started.stderr);
  assert.equal(fs.existsSync(f.data), false, "新入口不能静默写入旧根");
  const candidate = f.run("codex", ["task-resume-candidate", "--json"]);
  assert.equal(candidate.code, 0, candidate.stderr);
  assert.equal(JSON.parse(candidate.stdout).threadId, "thr_fake_1");
  const before = fs.readFileSync(f.record, "utf8");
  const changed = f.run("codex", ["task", "--resume", "--expected-thread-id", "outdated", "继续"]);
  assert.equal(changed.code, 1);
  assert.match(changed.stderr, /可续接线程已变化/);
  assert.equal(fs.readFileSync(f.record, "utf8"), before);
  const resumed = f.run("codex", ["task", "--resume", "--read-only", "继续"]);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.ok(f.readRecord().argv.includes("--session-id"));
  assert.equal(f.readRecord().permissionMode, "read-only");
});

test("共享根显式值优先，旧底层入口保留旧根，新入口默认使用用户共享根", () => {
  const f = fixture();
  const old = f.run("claude", ["task-resume-candidate", "--json"], { DEEPSEEK_DATA_DIR: "" });
  assert.equal(old.code, 0, old.stderr);
  assert.ok(fs.existsSync(path.join(f.home, ".deepseek-plugin")));
  assert.equal(fs.existsSync(f.data), false);
  const legacy = spawnSync(process.execPath, [COMPANION, "task-resume-candidate", "--json"], { cwd: f.cwd, encoding: "utf8",
    env: { ...process.env, DEEPSEEK_DATA_DIR: "", CLAUDE_PLUGIN_DATA: f.data,
      GIT_CEILING_DIRECTORIES: fs.realpathSync(os.tmpdir()) } });
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.ok(fs.existsSync(f.data));
  assert.equal(f.run("codex", ["task-resume-candidate", "--json"]).code, 0);
  assert.ok(fs.existsSync(f.shared));
});

test("宿主上下文只登记显式身份，Codex 不认领继承的 Claude 或 Codex 变量", () => {
  const f = fixture();
  const codex = f.run("codex", ["setup", "--json"]);
  assert.equal(codex.code, 0, codex.stderr);
  assert.deepEqual(JSON.parse(codex.stdout).hostContext, { host: "codex", sessionId: null, workspaceRoot: f.cwd, transcriptSource: null });
  assert.deepEqual(JSON.parse(codex.stdout).data, { root: f.shared, projects: path.join(f.shared, "projects"), legacySource: f.data });
  assert.equal(fs.existsSync(path.join(f.shared, "projects")), false, "环境检查不能提前占用迁移目标");
  const registered = f.run("codex", ["--session-id", "registered-codex", "--transcript-source", "registered.jsonl", "setup", "--json"]);
  assert.equal(registered.code, 0, registered.stderr);
  assert.deepEqual(JSON.parse(registered.stdout).hostContext, { host: "codex", sessionId: "registered-codex", workspaceRoot: f.cwd, transcriptSource: "registered.jsonl" });
  const claude = f.run("claude", ["setup", "--json"]);
  assert.equal(claude.code, 0, claude.stderr);
  assert.equal(JSON.parse(claude.stdout).hostContext.sessionId, "inherited-claude");
  const invalid = f.run("unknown", ["task", "不能执行"]);
  assert.notEqual(invalid.code, 0);
  assert.match(invalid.stderr, /宿主/);
});

test("实际 Claude 内联 Bash 选择共享根，原生会话钩子从同根清理且 SessionStart 静默", async () => {
  const f = fixture();
  const shared = path.join(f.home, ".deepseek-plugin");
  const plugin = fileURLToPath(new URL("../", import.meta.url)).replaceAll("\\", "/").replace(/\/$/, "");
  const gitPath = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
  assert.equal(gitPath.status, 0, gitPath.stderr);
  const bash = process.platform === "win32" ? path.resolve(gitPath.stdout.trim(), "../../..", "bin/bash.exe") : "bash";
  const invoke = (command, input = "") => spawnSync(bash, ["--noprofile", "--norc", "-c", command], {
    cwd: f.cwd, encoding: "utf8", input, env: { ...process.env, BASH_ENV: "", CLAUDE_PLUGIN_ROOT: plugin,
      DEEPSEEK_DATA_DIR: "", HOME: f.home, USERPROFILE: f.home, CLAUDE_PLUGIN_DATA: f.data, CLAUDE_SESSION_ID: "inherited-claude", CLAUDE_ENV_FILE: path.join(f.cwd, "env.sh"),
      DSH_BIN: f.bin, FAKE_DSH_RECORD: f.record, GIT_CEILING_DIRECTORIES: fs.realpathSync(os.tmpdir()) },
  });
  const command = fs.readFileSync(new URL("../commands/task.md", import.meta.url), "utf8").match(/```bash\r?\n([^\r\n]+)/)[1];
  const query = invoke(command);
  assert.equal(query.status, 0, query.stderr);
  assert.equal(JSON.parse(query.stdout).available, false);
  assert.ok(fs.existsSync(shared), "真实 Markdown 入口必须选择共享根");
  assert.equal(fs.existsSync(f.data), false);
  const config = JSON.parse(fs.readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8"));
  const start = invoke(config.hooks.SessionStart[0].hooks[0].command, JSON.stringify({ hook_event_name: "SessionStart", session_id: "inherited-claude", transcript_path: "registered.jsonl", cwd: f.cwd }));
  assert.equal(start.status, 0, start.stderr);
  assert.equal(start.stdout, "");
  assert.equal(start.stderr, "");
  const projects = path.join(shared, "projects");
  const jobs = path.join(projects, fs.readdirSync(projects)[0], "jobs");
  const logPath = path.join(jobs, "ended.log");
  fs.writeFileSync(logPath, "terminal\n");
  fs.writeFileSync(path.join(jobs, "ended.json"), JSON.stringify({ id: "ended", kind: "task", status: "completed", claudeSessionId: "inherited-claude", workspaceRoot: f.cwd,
    createdAt: "2020-01-01T00:00:00.000Z", logPath }));
  const ended = invoke(config.hooks.SessionEnd[0].hooks[0].command, JSON.stringify({ hook_event_name: "SessionEnd", session_id: "inherited-claude", cwd: f.cwd }));
  assert.equal(ended.status, 0, ended.stderr);
  assert.equal(ended.stdout, "");
  const deadline = Date.now() + 15000;
  while (fs.existsSync(logPath)) {
    assert.ok(Date.now() < deadline, "真实 SessionEnd 应清理共享根终态作业");
    await delay(50);
  }
  assert.equal(fs.existsSync(path.join(jobs, "ended.json")), false);
  assert.equal(fs.existsSync(f.record), false);
});

test("SessionStart 和空共享项目的 SessionEnd 不创建项目目录阻塞之后迁移", () => {
  const f = fixture();
  const envFile = path.join(f.cwd, "env.sh");
  const hook = (payload) => spawnSync(process.execPath, [entry, "claude", "session"], { cwd: f.cwd, input: JSON.stringify(payload), encoding: "utf8", env: {
    ...process.env, DEEPSEEK_DATA_DIR: f.shared, CLAUDE_PLUGIN_DATA: f.data, CLAUDE_ENV_FILE: envFile,
    GIT_CEILING_DIRECTORIES: fs.realpathSync(os.tmpdir()),
  } });
  for (const hook_event_name of ["SessionStart", "SessionEnd"]) {
    const result = hook({ hook_event_name, session_id: "registered", transcript_path: "registered.jsonl", cwd: f.cwd });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(fs.existsSync(path.join(f.shared, "projects")), false);
  }
});

test("共享宿主会话入口拒绝损坏 JSON，不回显敏感钩子输入", () => {
  const f = fixture();
  const secret = "sensitive-token-do-not-echo";
  const result = spawnSync(process.execPath, [entry, "claude", "session"], { cwd: f.cwd, input: secret, encoding: "utf8", env: {
    ...process.env, DEEPSEEK_DATA_DIR: f.shared, GIT_CEILING_DIRECTORIES: fs.realpathSync(os.tmpdir()),
  } });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, /sensitive|token-do-not-echo/);
  assert.equal(fs.existsSync(path.join(f.shared, "projects")), false);
});
