import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setup, makeGitRepo } from "./helpers.mjs";
import { resolveCodexTranscript } from "../scripts/lib/codex-transcript.mjs";

const entry = fileURLToPath(new URL("../scripts/deepseek-host.mjs", import.meta.url));
const sessionId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const line = (type, payload) => ({ timestamp: "2026-10-22T00:00:00Z", type, payload });
const message = (role, text, extra = {}) => line("response_item", {
  type: "message", role, ...(role === "assistant" ? { phase: "final_answer" } : {}),
  content: [{ type: role === "user" ? "input_text" : "output_text", text }], ...extra,
});

function fixture(t) {
  const f = setup();
  const cwd = makeGitRepo();
  const home = path.join(path.dirname(f.data), "codex-home");
  const shared = path.join(path.dirname(f.data), "shared");
  const source = path.join(home, "sessions", "2026", "10", "22", "rollout.jsonl");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  const run = (args, { id = sessionId, transcriptSource, env = {}, input, at = cwd, host = "codex" } = {}) => {
    const result = spawnSync(process.execPath, [entry, host, ...(id ? ["--session-id", id] : []),
      ...(transcriptSource === undefined ? [] : ["--transcript-source", transcriptSource]), ...args], {
      cwd: at, encoding: "utf8", input, env: { ...process.env, DEEPSEEK_DATA_DIR: shared,
        CODEX_HOME: home, DSH_BIN: f.bin, FAKE_DSH_RECORD: f.record,
        GIT_CEILING_DIRECTORIES: path.dirname(cwd), CLAUDE_TRANSCRIPT_PATH: "inherited-private.jsonl", ...env },
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const meta = (extra = {}) => line("session_meta", { id: sessionId, session_id: sessionId, cwd, source: "cli", cli_version: "0.162.1", ...extra });
  const write = (records, target = source) => fs.writeFileSync(target, records.map(record => JSON.stringify(record)).join("\n") + "\n");
  const start = (transcript = source) => run(["session"], { id: null, input: JSON.stringify({
    hook_event_name: "SessionStart", session_id: sessionId, cwd, transcript_path: transcript,
  }) });
  t.after(() => {
    for (const target of [path.dirname(f.data), cwd]) fs.rmSync(target, { recursive: true, force: true });
  });
  return { ...f, cwd, home, shared, source, run, meta, write, start };
}

const windowsOnly = { skip: process.platform !== "win32" && "仅 Windows 支持本回归用例的命名空间路径" };
for (const prefix of ["\\\\?\\"]) {
  test(`Codex Windows 前缀 ${prefix} 的登记及显式来源与普通路径转交一致`, windowsOnly, (t) => {
    const f = fixture(t);
    f.write([f.meta(), message("user", "目标：WINDOWS_TRANSCRIPT_SOURCE"), message("assistant", "约束：保持身份校验。")]);
    const original = fs.readFileSync(f.source, "utf8");
    const plain = f.run(["transfer", "--source", f.source, "--json"]);
    assert.equal(plain.code, 0, plain.stderr);
    const expected = JSON.parse(plain.stdout);
    const sent = f.readRecord();
    const source = prefix + f.source;
    assert.equal(f.start(source).code, 0);
    const owners = path.join(f.shared, "hosts", "codex");
    const ownerFile = path.join(owners, fs.readdirSync(owners)[0], "session.json");
    const ownerBefore = fs.readFileSync(ownerFile, "utf8");
    assert.equal(JSON.parse(ownerBefore).transcriptSource, source);
    for (const [args, options] of [
      [["transfer", "--json"], {}],
      [["transfer", "--json"], { transcriptSource: source }],
      [["transfer", "--source", source, "--json"], { id: null }],
    ]) {
      const result = f.run(args, options);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), expected);
      const record = f.readRecord();
      assert.equal(record.stdin, sent.stdin);
      assert.equal(record.cwd, f.cwd);
      assert.equal(record.permissionMode, "read-only");
    }
    assert.equal(fs.readFileSync(f.source, "utf8"), original);
    assert.equal(fs.readFileSync(ownerFile, "utf8"), ownerBefore);
  });

  test(`Codex Windows 前缀 ${prefix} 仍拒绝越界、非 .jsonl 和非普通文件`, windowsOnly, (t) => {
    const f = fixture(t);
    const outside = path.join(f.home, "outside.jsonl");
    const wrong = path.join(path.dirname(f.source), "wrong.txt");
    const directory = path.join(path.dirname(f.source), "directory.jsonl");
    const linked = path.join(path.dirname(f.source), "linked.jsonl");
    f.write([f.meta(), message("user", "目标：不得转交的记录。")], outside);
    fs.copyFileSync(outside, wrong);
    fs.mkdirSync(directory);
    fs.symlinkSync(f.home, linked, "junction");
    for (const target of [outside, wrong, directory, path.join(linked, "outside.jsonl")]) {
      const plain = f.run(["transfer", "--source", target, "--json"]);
      assert.notEqual(plain.code, 0);
      assert.match(plain.stderr, /只接受 CODEX_HOME\/sessions 下已存在的普通 \.jsonl 会话记录；不允许链接逃逸。/);
      const source = prefix + target;
      assert.equal(f.start(source).code, 0);
      for (const args of [["transfer", "--json"], ["transfer", "--source", source, "--json"]]) {
        const result = f.run(args);
        assert.equal(result.code, plain.code);
        assert.equal(result.stderr, plain.stderr);
        assert.equal(result.stdout, "");
        assert.equal(fs.existsSync(f.record), false);
      }
    }
  });

  test(`Codex Windows 前缀 ${prefix} 的盘符及 UNC 来源在 realpath 校验前转换`, windowsOnly, (t) => {
    const f = fixture(t);
    f.write([f.meta(), message("user", "目标：UNC 路径。")]);
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = f.home;
    t.after(() => { if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome; });
    assert.equal(resolveCodexTranscript(f.cwd, prefix + f.source).source, f.source);
    const outside = path.join(f.home, "outside.jsonl");
    const wrong = path.join(path.dirname(f.source), "wrong.txt");
    const directory = path.join(path.dirname(f.source), "directory.jsonl");
    fs.copyFileSync(f.source, outside);
    fs.copyFileSync(f.source, wrong);
    fs.mkdirSync(directory);
    for (const target of [outside, wrong, directory]) {
      assert.throws(() => resolveCodexTranscript(f.cwd, prefix + target),
        /只接受 CODEX_HOME\/sessions 下已存在的普通 \.jsonl 会话记录；不允许链接逃逸。/);
    }
    const realpath = fs.realpathSync;
    let requested;
    // 不访问网络共享；仅核对进入既有 realpath 校验的 UNC 路径。
    t.mock.method(fs, "realpathSync", (target, ...args) => {
      if (typeof target === "string" && target.includes("server\\share")) {
        requested = target;
        return f.source;
      }
      return realpath(target, ...args);
    });
    assert.equal(resolveCodexTranscript(f.cwd, prefix + "UNC\\server\\share\\rollout.jsonl").source, f.source);
    assert.equal(requested, "\\\\server\\share\\rollout.jsonl");
  });
}

test("Codex 拒绝单反斜杠 Windows 前缀来源", windowsOnly, (t) => {
  const f = fixture(t);
  f.write([f.meta(), message("user", "目标：拒绝无效前缀。")]);
  const result = f.run(["transfer", "--source", "\\?\\" + f.source, "--json"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /只接受 CODEX_HOME\/sessions 下已存在的普通 \.jsonl 会话记录；不允许链接逃逸。/);
  assert.equal(result.stdout, "");
  assert.equal(fs.existsSync(f.record), false);
});

test("Codex 显式来源共用五部分交接说明，在项目根只读新开线程且保留原记录和候选", (t) => {
  const f = fixture(t);
  f.write([f.meta(), message("user", "目标：补齐分页。"), message("assistant", "约束：保留公开接口。"),
    message("user", "涉及文件：src/page.mjs。\n验收标准：npm test 通过。\n输出要求：简体中文。")]);
  assert.equal(f.run(["task", "--fresh", "原有候选"], { env: { FAKE_DSH_THREAD_ID: "kept-thread" } }).code, 0);
  const before = f.run(["task-resume-candidate", "--json"]).stdout;
  const original = fs.readFileSync(f.source, "utf8");
  const result = f.run(["transfer", "--source", f.source, "--cwd", path.join(f.cwd, "sub"), "--json"]);
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  for (const title of ["目标", "已定决策与约束（含不要做的事）", "涉及文件", "验收标准", "输出要求"]) assert.ok(payload.handoff.includes(`## ${title}`));
  for (const text of ["用户", "Codex", "补齐分页", "保留公开接口", "src/page.mjs", "npm test 通过", "简体中文"]) assert.ok(payload.handoff.includes(text), text);
  assert.match(payload.handoff, /仅转交.*确认收到.*等待用户继续/);
  assert.equal(payload.resumeCommand, "dsh tui --resume thr_fake_1");
  assert.ok(payload.harnessInstructions.includes(f.cwd));
  assert.match(payload.harnessInstructions, /登记.*工作区/);
  const sent = f.readRecord();
  assert.equal(sent.cwd, f.cwd);
  assert.equal(sent.permissionMode, "read-only");
  assert.equal(sent.argv.includes("--session-id"), false);
  assert.ok(sent.stdin.startsWith(payload.handoff));
  assert.match(sent.stdin, /不请求提升权限|不要请求提升权限/);
  assert.equal(fs.readFileSync(f.source, "utf8"), original);
  assert.equal(f.run(["task-resume-candidate", "--json"]).stdout, before);
});

test("Codex 来源按命令级、显式宿主、SessionStart 登记优先，显式选择可无当前身份", (t) => {
  const f = fixture(t);
  f.write([f.meta(), message("user", "目标：REGISTERED_SOURCE")]);
  assert.equal(f.start().code, 0);
  const owners = path.join(f.shared, "hosts", "codex");
  const ownerFile = path.join(owners, fs.readdirSync(owners)[0], "session.json");
  const ownerBefore = fs.readFileSync(ownerFile, "utf8");
  const registered = f.run(["transfer", "--json"]);
  assert.equal(registered.code, 0, registered.stderr);
  assert.match(JSON.parse(registered.stdout).handoff, /REGISTERED_SOURCE/);
  const bound = path.join(path.dirname(f.source), "bound.jsonl");
  f.write([f.meta(), message("user", "目标：BOUND_SOURCE")], bound);
  const selected = f.run(["transfer", "--json"], { transcriptSource: bound });
  assert.equal(selected.code, 0, selected.stderr);
  assert.match(JSON.parse(selected.stdout).handoff, /BOUND_SOURCE/);
  assert.equal(fs.readFileSync(ownerFile, "utf8"), ownerBefore);
  const explicit = path.join(path.dirname(f.source), "explicit.jsonl");
  f.write([f.meta({ id: otherId, session_id: otherId }), message("user", "目标：EXPLICIT_SOURCE")], explicit);
  fs.writeFileSync(ownerFile, "{CORRUPT_OWNER_MUST_NOT_BE_READ");
  for (const id of [sessionId, null]) {
    const chosen = f.run(["transfer", "--source", explicit, "--json"], { id, transcriptSource: bound });
    assert.equal(chosen.code, 0, chosen.stderr);
    assert.match(JSON.parse(chosen.stdout).handoff, /EXPLICIT_SOURCE/);
  }
  const unregistered = f.run(["transfer", "--json"], { id: otherId, transcriptSource: explicit });
  assert.equal(unregistered.code, 0, unregistered.stderr);
  assert.match(JSON.parse(unregistered.stdout).handoff, /EXPLICIT_SOURCE/);
});

test("Codex 未知身份、无登记、空来源和绑定来源缺身份时停止，不扫描或继承 Claude 来源", (t) => {
  const f = fixture(t);
  f.write([f.meta(), message("user", "目标：可用但未被选择的记录。")]);
  for (const options of [{}, { id: null }, { id: null, transcriptSource: f.source }]) {
    const result = f.run(["transfer", "--json"], options);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /身份|登记|来源|记录/);
    assert.equal(fs.existsSync(f.record), false);
  }
  assert.equal(f.start(null).code, 0);
  const empty = f.run(["transfer", "--json"]);
  assert.notEqual(empty.code, 0);
  assert.equal(empty.stdout, "");
  assert.equal(fs.existsSync(f.record), false);
});

test("Codex 首条 metadata 核对主线程和项目，登记及绑定来源核对明确身份", (t) => {
  const f = fixture(t);
  const foreign = makeGitRepo();
  t.after(() => fs.rmSync(foreign, { recursive: true, force: true }));
  const invalid = [
    { id: null }, { id: "unknown-id" }, { session_id: otherId }, { session_id: null },
    { cwd: foreign }, { cwd: "relative-project" }, { cwd: null }, { cwd: path.join(f.cwd, "missing") },
    { source: "appServer" }, { source: "app-server" }, { source: "unknown" }, { source: null }, { source: undefined },
    { source: { custom: "chatgpt" } }, { source: { internal: "review" } },
    { source: { subagent: { thread_spawn: { parent_thread_id: otherId } } } },
    { parent_thread_id: otherId },
  ];
  for (const patch of invalid) {
    f.write([f.meta(patch), message("user", "目标：PRIVATE_REJECTED_PAYLOAD")]);
    const result = f.run(["transfer", "--source", f.source, "--json"]);
    assert.notEqual(result.code, 0, JSON.stringify(patch));
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /PRIVATE_REJECTED_PAYLOAD/);
    assert.equal(fs.existsSync(f.record), false);
  }
  f.write([f.meta({ id: otherId, session_id: otherId }), message("user", "目标：PRIVATE_FOREIGN_SESSION")]);
  assert.equal(f.start().code, 0);
  for (const options of [{}, { transcriptSource: f.source }]) {
    const result = f.run(["transfer", "--json"], options);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /身份|编号/);
    assert.equal(result.stdout, "");
    assert.equal(fs.existsSync(f.record), false);
  }
  const owners = path.join(f.shared, "hosts", "codex");
  const ownerFile = path.join(owners, fs.readdirSync(owners)[0], "session.json");
  const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
  fs.writeFileSync(ownerFile, JSON.stringify({ ...owner, workspaceRoot: foreign }));
  f.write([f.meta(), message("user", "目标：PRIVATE_WRONG_OWNER_PROJECT")]);
  const wrongProject = f.run(["transfer", "--json"]);
  assert.notEqual(wrongProject.code, 0);
  assert.match(wrongProject.stderr, /项目/);
  assert.equal(fs.existsSync(f.record), false);
});

test("Codex 已核实来源及旧 metadata 缺 session_id 可用，fork 后续父 metadata 不改首条身份", (t) => {
  const f = fixture(t);
  for (const source of ["cli", "vscode", "exec", "mcp"]) {
    const first = f.meta({ source, cwd: path.join(f.cwd, "sub"), forked_from_id: otherId });
    delete first.payload.session_id;
    f.write([first, f.meta({ id: otherId, session_id: otherId, cwd: "父记录保持历史信息" }),
      message("user", "目标：VALID_FORK_GOAL")]);
    const result = f.run(["transfer", "--json"], { transcriptSource: f.source });
    assert.equal(result.code, 0, result.stderr);
    assert.match(JSON.parse(result.stdout).handoff, /VALID_FORK_GOAL/);
  }
});

test("Codex 仅取 response_item 用户文字与明确最终回复，双表示不重复且真实重复保留，工具只留概况", (t) => {
  const f = fixture(t);
  const privateValues = ["PRIVATE_REASONING", "PRIVATE_COMMENTARY", "PRIVATE_PARTIAL", "PRIVATE_UNKNOWN_PHASE", "PRIVATE_NO_PHASE",
    "PRIVATE_ANALYSIS_CHANNEL", "PRIVATE_UNKNOWN_CHANNEL", "PRIVATE_SYSTEM", "PRIVATE_DEVELOPER", "PRIVATE_AGENT_MESSAGE",
    "PRIVATE_TOOL_ARGS", "PRIVATE_TOOL_OUTPUT", "PRIVATE_ENCRYPTED", "PRIVATE_IMAGE", "PRIVATE_AUDIO", "PRIVATE_INLINE_ANALYSIS",
    "PRIVATE_CODE_BODY", "PRIVATE_FILE_BODY", "PRIVATE_TOKEN_VALUE", "PRIVATE_MULTILINE_VALUE"];
  const noPhase = message("assistant", "PRIVATE_NO_PHASE");
  delete noPhase.payload.phase;
  f.write([f.meta(),
    line("event_msg", { type: "user_message", message: "PAIR_USER" }), message("user", "PAIR_USER"),
    message("user", "REPEATED_USER"), message("user", "REPEATED_USER"),
    line("event_msg", { type: "agent_message", message: "PAIR_FINAL", phase: "final_answer" }), message("assistant", "PAIR_FINAL"),
    message("assistant", "PRIVATE_COMMENTARY", { phase: "commentary" }),
    message("assistant", "PRIVATE_PARTIAL", { phase: "partial_answer" }),
    message("assistant", "PRIVATE_UNKNOWN_PHASE", { phase: "future_phase" }), noPhase,
    message("assistant", "PRIVATE_ANALYSIS_CHANNEL", { channel: "analysis" }),
    message("assistant", "PRIVATE_UNKNOWN_CHANNEL", { channel: "future_channel" }),
    message("system", "PRIVATE_SYSTEM"), message("developer", "PRIVATE_DEVELOPER"),
    line("response_item", { type: "agent_message", content: [{ type: "input_text", text: "PRIVATE_AGENT_MESSAGE" }] }),
    line("response_item", { type: "reasoning", summary: [{ text: "PRIVATE_REASONING" }], encrypted_content: "PRIVATE_ENCRYPTED" }),
    line("response_item", { type: "function_call", name: "exec_command", call_id: "call-1", arguments: "PRIVATE_TOOL_ARGS" }),
    line("response_item", { type: "custom_tool_call", name: "apply_patch", call_id: "call-2", input: "PRIVATE_CODE_BODY" }),
    line("response_item", { type: "local_shell_call", action: { command: ["PRIVATE_TOOL_ARGS"] } }),
    line("response_item", { type: "function_call_output", call_id: "call-1", output: "PRIVATE_TOOL_OUTPUT" }),
    line("response_item", { type: "custom_tool_call_output", call_id: "call-2", output: "PRIVATE_TOOL_OUTPUT" }),
    line("event_msg", { type: "item_completed", item: { text: "PRIVATE_TOOL_OUTPUT" } }),
    message("user", "", { content: [{ type: "input_image", image_url: "PRIVATE_IMAGE" }, { type: "input_audio", audio_url: "PRIVATE_AUDIO" }] }),
    message("user", "目标：保留正常目标。\n<analysis>PRIVATE_INLINE_ANALYSIS</analysis>\n```js\nPRIVATE_CODE_BODY\n```\n<file>PRIVATE_FILE_BODY</file>\napiKey=PRIVATE_TOKEN_VALUE\nAccess Token: |\n  PRIVATE_MULTILINE_VALUE\n输出要求：仅确认收到。"),
  ]);
  const result = f.run(["transfer", "--source", f.source, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const all = result.stdout + result.stderr + f.readRecord().stdin;
  for (const value of privateValues) assert.equal(all.includes(value), false, value);
  assert.equal(payload.handoff.match(/PAIR_USER/g)?.length, 1);
  assert.equal(payload.handoff.match(/PAIR_FINAL/g)?.length, 1);
  assert.equal(payload.handoff.match(/REPEATED_USER/g)?.length, 2);
  assert.match(payload.handoff, /工具 exec_command[^\n]*参数正文和输出已省略/);
  assert.match(payload.handoff, /工具 apply_patch[^\n]*结果未核实/);
  assert.match(payload.handoff, /保留正常目标/);
  assert.match(payload.handoff, /已隐藏/);
});

test("Codex 未知消息格式、event-only、无效 JSON 和不可转交文字明确失败，不回显或发送原记录", (t) => {
  const f = fixture(t);
  const badRecords = [
    [message("user", "PRIVATE_NO_META")],
    [f.meta(), line("event_msg", { type: "user_message", message: "PRIVATE_EVENT_ONLY" })],
    [f.meta(), line("response_item", { type: "future_message", text: "PRIVATE_UNKNOWN_FORMAT" }), message("user", "PRIVATE_VALID_AFTER_UNKNOWN")],
    [f.meta(), message("user", "", { content: "PRIVATE_WRONG_CONTENT" })],
    [f.meta(), message("user", "", { content: [{ type: "future_text", text: "PRIVATE_UNKNOWN_TEXT" }] })],
    [f.meta(), line("future_record", { text: "PRIVATE_UNKNOWN_ENVELOPE" }), message("user", "PRIVATE_VALID_AFTER_UNKNOWN")],
    [f.meta(), null, message("user", "PRIVATE_VALID_AFTER_NULL")],
  ];
  for (const records of badRecords) {
    f.write(records);
    const result = f.run(["transfer", "--source", f.source, "--json"]);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /格式|不支持/);
    assert.doesNotMatch(result.stderr, /PRIVATE_/);
    assert.equal(fs.existsSync(f.record), false);
  }
  for (const content of ["", "{PRIVATE_BROKEN_JSON", JSON.stringify(f.meta()) + "\n{PRIVATE_BROKEN_TAIL"]) {
    fs.writeFileSync(f.source, content);
    const result = f.run(["transfer", "--source", f.source, "--json"]);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /PRIVATE_/);
    assert.equal(fs.existsSync(f.record), false);
  }
  const partial = message("assistant", "PRIVATE_NO_FINAL", { phase: "commentary" });
  f.write([f.meta(), partial]);
  const noFinal = f.run(["transfer", "--source", f.source, "--json"]);
  assert.notEqual(noFinal.code, 0);
  assert.equal(fs.existsSync(f.record), false);
});

test("Codex 受限来源拒绝目录、非 JSONL、伪前缀、链接逃逸和损坏登记，不扩大 Claude 来源范围", (t) => {
  const f = fixture(t);
  const records = [f.meta(), message("user", "目标：PRIVATE_PATH_CONTENT")];
  f.write(records);
  const outside = path.join(f.home, "outside");
  const prefix = path.join(f.home, "sessions-extra");
  const sessions = path.join(f.home, "sessions");
  for (const dir of [outside, prefix]) fs.mkdirSync(dir);
  const outsideFile = path.join(outside, "secret.jsonl");
  const prefixFile = path.join(prefix, "secret.jsonl");
  for (const file of [outsideFile, prefixFile]) f.write(records, file);
  const directory = path.join(sessions, "directory.jsonl");
  fs.mkdirSync(directory);
  const wrongExtension = path.join(sessions, "secret.txt");
  f.write(records, wrongExtension);
  fs.symlinkSync(outside, path.join(sessions, "linked"), process.platform === "win32" ? "junction" : "dir");
  for (const source of [directory, wrongExtension, outsideFile, prefixFile, path.join(sessions, "..", "outside", "secret.jsonl"),
    path.join(sessions, "linked", "secret.jsonl"), path.join(sessions, "missing.jsonl")]) {
    const result = f.run(["transfer", "--source", source, "--json"]);
    assert.notEqual(result.code, 0, source);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /PRIVATE_PATH_CONTENT/);
    assert.equal(fs.existsSync(f.record), false);
  }
  assert.equal(f.start().code, 0);
  const owners = path.join(f.shared, "hosts", "codex");
  const ownerFile = path.join(owners, fs.readdirSync(owners)[0], "session.json");
  const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
  const missingProject = { ...owner };
  delete missingProject.workspaceRoot;
  for (const value of ["{PRIVATE_CORRUPT_OWNER", JSON.stringify(missingProject), JSON.stringify({ ...owner, transcriptSource: {} })]) {
    fs.writeFileSync(ownerFile, value);
    const result = f.run(["transfer", "--json"]);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /PRIVATE_/);
    assert.equal(fs.existsSync(f.record), false);
  }
  const claude = path.join(f.home, "claude");
  const denied = f.run(["transfer", "--source", f.source, "--json"], { env: { CODEX_HOME: claude, CLAUDE_TRANSCRIPT_PATH: f.source } });
  assert.notEqual(denied.code, 0);
  assert.equal(fs.existsSync(f.record), false);
  const directClaude = f.run(["transfer", "--source", f.source, "--json"], { host: "claude", env: { CLAUDE_CONFIG_DIR: f.home } });
  assert.notEqual(directClaude.code, 0);
  assert.match(directClaude.stderr, /Claude.*项目目录/);
  assert.equal(fs.existsSync(f.record), false);
});

test("Codex 文字与工具概况共用预算，保留近期要求和 UTF-16 预算，失败不输出伪续接命令", (t) => {
  const f = fixture(t);
  f.write([f.meta(), message("user", "目标：EARLY_GOAL。" + "😀早期文字".repeat(500)),
    ...Array.from({ length: 20 }, (_, i) => line("response_item", { type: "function_call", name: "exec_command", call_id: `call-${i}`, arguments: "PRIVATE_BUDGET_ARGS" })),
    message("assistant", "约束：保持兼容。"), message("user", "验收标准：RECENT_ACCEPTANCE。\n输出要求：RECENT_OUTPUT。")]);
  const result = f.run(["transfer", "--source", f.source, "--max-chars", "512", "--json"]);
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.handoff.length <= 512);
  assert.ok(payload.omittedTools > 0);
  assert.ok(payload.compressedMessages > 0);
  assert.match(payload.handoff, /RECENT_ACCEPTANCE/);
  assert.match(payload.handoff, /RECENT_OUTPUT/);
  assert.ok(f.readRecord().stdin.startsWith(payload.handoff));
  for (const mode of ["no-session", "no-final", "incomplete", "exit-nonzero", "error"]) {
    const failed = f.run(["transfer", "--source", f.source, "--json"], { env: { FAKE_DSH_MODE: mode } });
    assert.equal(failed.code, 1);
    const output = JSON.parse(failed.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.resumeCommand, undefined);
    assert.match(output.error, /转交未完成/);
  }
});

test("Codex 非 Git 项目经 junction 或 symlink 调用时，dsh 与 Harness 使用已核实的真实项目根", (t) => {
  const f = fixture(t);
  const realProject = path.join(path.dirname(f.data), "real-project");
  const aliasProject = path.join(path.dirname(f.data), "alias-project");
  fs.mkdirSync(realProject);
  fs.symlinkSync(realProject, aliasProject, process.platform === "win32" ? "junction" : "dir");
  const expectedRoot = fs.realpathSync(realProject);
  f.write([f.meta({ cwd: expectedRoot }), message("user", "目标：转交非 Git 项目的要求。")]);
  const result = f.run(["transfer", "--source", f.source, "--cwd", aliasProject, "--json"], {
    env: { GIT_CEILING_DIRECTORIES: path.dirname(f.data) },
  });
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(f.readRecord().cwd, expectedRoot);
  assert.ok(payload.harnessInstructions.includes(expectedRoot), payload.harnessInstructions);
  assert.equal(payload.harnessInstructions.includes(aliasProject), false);
});
