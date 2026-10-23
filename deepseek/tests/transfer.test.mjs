import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setup, makeGitRepo } from "./helpers.mjs";
import { resolveTranscript } from "../scripts/lib/transfer.mjs";

const message = (role, content) => ({ type: role, message: { role, content } });
function fixture() {
  const base = setup();
  const config = path.join(path.dirname(base.data), "claude-config");
  const projects = path.join(config, "projects");
  const source = path.join(projects, "project", "session.jsonl");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  const cwd = makeGitRepo();
  return { ...base, config, projects, source, cwd,
    write: (records) => fs.writeFileSync(source, records.map((record) => JSON.stringify(record)).join("\n") + "\n"),
    transfer: (args = [], env = {}) => base.run(["transfer", ...args], { cwd,
      env: { CLAUDE_CONFIG_DIR: config, CLAUDE_TRANSCRIPT_PATH: source, ...env } }),
  };
}

const windowsOnly = { skip: process.platform !== "win32" && "仅 Windows 支持本回归用例的命名空间路径" };
for (const prefix of ["\\\\?\\"]) {
  test(`Claude Windows 前缀 ${prefix} 的登记及显式来源与普通路径转交一致`, windowsOnly, (t) => {
    const f = fixture();
    t.after(() => {
      for (const target of [path.dirname(f.data), f.cwd]) fs.rmSync(target, { recursive: true, force: true });
    });
    f.write([message("user", "目标：WINDOWS_CLAUDE_SOURCE")]);
    const plain = f.transfer(["--json"]);
    assert.equal(plain.code, 0, plain.stderr);
    const expected = JSON.parse(plain.stdout);
    const sent = f.readRecord();
    const source = prefix + f.source;
    for (const [args, env] of [[["--json"], { CLAUDE_TRANSCRIPT_PATH: source }], [["--source", source, "--json"], {}]]) {
      const result = f.transfer(args, env);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), expected);
      assert.equal(f.readRecord().stdin, sent.stdin);
      assert.equal(f.readRecord().cwd, f.cwd);
      assert.equal(f.readRecord().permissionMode, "read-only");
    }
    const outside = path.join(f.config, "outside.jsonl");
    const wrong = path.join(f.projects, "wrong.txt");
    const directory = path.join(f.projects, "directory.jsonl");
    fs.copyFileSync(f.source, outside);
    fs.copyFileSync(f.source, wrong);
    fs.mkdirSync(directory);
    fs.rmSync(f.record);
    for (const target of [outside, wrong, directory]) {
      const rejected = f.transfer(["--source", target]);
      assert.notEqual(rejected.code, 0);
      const result = f.transfer(["--source", prefix + target]);
      assert.equal(result.code, rejected.code);
      assert.equal(result.stderr, rejected.stderr);
      assert.equal(result.stdout, "");
      assert.equal(fs.existsSync(f.record), false);
    }
  });

  test(`Claude Windows 前缀 ${prefix} 的盘符及 UNC 来源在 realpath 校验前转换`, windowsOnly, (t) => {
    const f = fixture();
    t.after(() => {
      for (const target of [path.dirname(f.data), f.cwd]) fs.rmSync(target, { recursive: true, force: true });
    });
    f.write([message("user", "目标：UNC 路径。")]);
    const previousConfig = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = f.config;
    t.after(() => { if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousConfig; });
    assert.equal(resolveTranscript(f.cwd, prefix + f.source), f.source);
    const outside = path.join(f.config, "outside.jsonl");
    const wrong = path.join(f.projects, "wrong.txt");
    const directory = path.join(f.projects, "directory.jsonl");
    fs.copyFileSync(f.source, outside);
    fs.copyFileSync(f.source, wrong);
    fs.mkdirSync(directory);
    for (const target of [outside, wrong, directory]) {
      let originalError;
      try { resolveTranscript(f.cwd, target); } catch (error) { originalError = error; }
      assert.ok(originalError);
      assert.throws(() => resolveTranscript(f.cwd, prefix + target), { message: originalError.message });
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
    assert.equal(resolveTranscript(f.cwd, prefix + "UNC\\server\\share\\session.jsonl"), f.source);
    assert.equal(requested, "\\\\server\\share\\session.jsonl");
  });
}

test("Claude 拒绝单反斜杠 Windows 前缀来源", windowsOnly, (t) => {
  const f = fixture();
  t.after(() => {
    for (const target of [path.dirname(f.data), f.cwd]) fs.rmSync(target, { recursive: true, force: true });
  });
  f.write([message("user", "目标：拒绝无效前缀。")]);
  const result = f.transfer(["--source", "\\?\\" + f.source]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /只接受 Claude 项目目录下已存在的普通 \.jsonl 会话记录；不允许链接逃逸。/);
  assert.equal(result.stdout, "");
  assert.equal(fs.existsSync(f.record), false);
});

test("转交只接受 Claude 项目目录下的普通 .jsonl，拒绝缺失路径、伪前缀和链接逃逸", () => {
  const f = fixture();
  const outside = path.join(f.config, "outside");
  const sibling = path.join(f.config, "projects-extra");
  fs.mkdirSync(outside);
  fs.mkdirSync(sibling);
  for (const dir of [outside, sibling]) fs.writeFileSync(path.join(dir, "secret.jsonl"), "不应读取的内容");
  const wrong = path.join(f.projects, "wrong.txt");
  fs.writeFileSync(wrong, "不是会话记录");
  const directory = path.join(f.projects, "directory.jsonl");
  fs.mkdirSync(directory);
  fs.symlinkSync(outside, path.join(f.projects, "linked"), process.platform === "win32" ? "junction" : "dir");
  for (const source of ["", wrong, directory, f.source, path.join(outside, "secret.jsonl"),
    path.join(sibling, "secret.jsonl"), path.join(f.projects, "linked", "secret.jsonl")]) {
    const result = f.transfer(source ? ["--source", source] : [], { CLAUDE_TRANSCRIPT_PATH: "" });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /记录|source|\.jsonl|目录/);
    assert.equal(result.stdout, "");
    assert.equal(fs.existsSync(f.record), false);
  }
});

test("转交从登记路径读取文字往来，生成五部分交接说明并在项目根新开线程", () => {
  const f = fixture();
  f.write([
    message("user", "目标：补齐分页 API。"),
    message("assistant", [{ type: "text", text: "已定决策与约束：使用游标分页。不要修改公开接口。" }]),
    message("user", [{ type: "text", text: "涉及文件：src/page.mjs（分页逻辑）；tests/page.test.mjs（边界测试）。\n验收标准：npm test 通过；空页返回 []。\n输出要求：简体中文汇报改动与测试。" }]),
  ]);
  const original = fs.readFileSync(f.source, "utf8");
  const candidate = f.run(["task-resume-candidate", "--json"], { cwd: f.cwd }).stdout;
  const result = f.transfer(["--json"]);
  assert.equal(result.code, 0, result.stderr);
  const transferred = JSON.parse(result.stdout);
  assert.equal(transferred.ok, true);
  assert.equal(transferred.threadId, "thr_fake_1");
  assert.equal(transferred.resumeCommand, "dsh tui --resume thr_fake_1");
  for (const title of ["目标", "已定决策与约束（含不要做的事）", "涉及文件", "验收标准", "输出要求"])
    assert.ok(transferred.handoff.includes(`## ${title}`), title);
  for (const text of ["用户", "Claude", "补齐分页 API", "使用游标分页", "不要修改公开接口", "src/page.mjs", "npm test 通过", "空页返回 []", "简体中文汇报"])
    assert.ok(transferred.handoff.includes(text), text);
  assert.match(transferred.harnessInstructions, /Harness/);
  assert.ok(transferred.harnessInstructions.includes(transferred.threadId));
  const record = f.readRecord();
  assert.equal(record.cwd, f.cwd);
  assert.equal(record.permissionMode, "read-only", "转交首条消息仅登记交接说明，不启动工作");
  assert.ok(record.stdin.startsWith(transferred.handoff));
  assert.equal(record.argv.includes("--session-id"), false);
  assert.match(record.stdin, /不要请求提升权限/);
  assert.equal(fs.readFileSync(f.source, "utf8"), original);
  assert.equal(f.run(["task-resume-candidate", "--json"], { cwd: f.cwd }).stdout, candidate);
});

test("交接说明排除文件全文、完整工具输出、密钥和思考过程，工具调用只保留一行概况", () => {
  const f = fixture();
  const secrets = ["sk-synthetic-secret-123456", "TOKEN_VALUE_PRIVATE", "bearer-private-value", "URL_PRIVATE_PASSWORD"];
  f.write([
    message("user", "目标：修复缓存。\n```js\nconst FILE_FULL_PAYLOAD = '不得转交';\n```\n约束：不要扩大缓存范围。"),
    message("assistant", [
      { type: "thinking", thinking: "PRIVATE_THINKING_PAYLOAD" },
      { type: "redacted_thinking", data: "PRIVATE_REDACTED_PAYLOAD" },
      { type: "text", text: `决策：保留现有接口。apiKey="${secrets[0]}"; token=${secrets[1]}\nAuthorization: Bearer ${secrets[2]}\nhttps://user:${secrets[3]}@example.invalid/path\n<file_contents>FULL_FILE_XML</file_contents>\n<thinking>PRIVATE_INLINE_THOUGHT</thinking>` },
      { type: "tool_use", id: "write1", name: "Write", input: { file_path: "src/cache.mjs", content: "WRITE_FULL_CONTENT" } },
      { type: "tool_use", id: "read1", name: "Read", input: { file_path: "src/cache.mjs" } },
      { type: "tool_use", id: "bash1", name: "Bash", input: { command: "echo SHELL_COMMAND_PRIVATE" } },
    ]),
    message("user", [{ type: "tool_result", tool_use_id: "read1", content: "FULL_TOOL_OUTPUT", is_error: false }]),
    message("assistant", [{ type: "text", text: "验收标准：npm test 通过。\n输出要求：报告缓存改动。" }, { type: "document", source: { text: "DOCUMENT_FULL_CONTENT" } }]),
    { type: "progress", data: { message: "PROGRESS_PRIVATE_CONTENT" } },
  ]);
  const result = f.transfer(["--json"]);
  assert.equal(result.code, 0, result.stderr);
  const handoff = JSON.parse(result.stdout).handoff;
  for (const text of [...secrets, "FILE_FULL_PAYLOAD", "PRIVATE_THINKING_PAYLOAD", "PRIVATE_REDACTED_PAYLOAD", "FULL_FILE_XML",
    "PRIVATE_INLINE_THOUGHT", "WRITE_FULL_CONTENT", "SHELL_COMMAND_PRIVATE", "FULL_TOOL_OUTPUT", "DOCUMENT_FULL_CONTENT", "PROGRESS_PRIVATE_CONTENT"])
    assert.equal((result.stdout + result.stderr + f.readRecord().stdin).includes(text), false, text);
  assert.match(handoff, /保留现有接口/);
  assert.match(handoff, /不要扩大缓存范围/);
  assert.match(handoff, /src\/cache\.mjs/);
  assert.match(handoff, /工具 Write[^\n]*请求写入/);
  assert.match(handoff, /工具 Read[^\n]*读取/);
  assert.match(handoff, /工具 Bash[^\n]*省略/);
  assert.equal(handoff.split("\n").filter((line) => line.includes("工具 Write")).length, 1);
  assert.match(handoff, /已隐藏/);
});

test("长度预算先删旧工具说明，再压缩早期对话，保留五部分与近期要求", () => {
  const f = fixture();
  const early = "目标：EARLY_KEEP_IN_FULL。" + "分页需求说明。".repeat(35);
  const latest = "验收标准：RECENT_ACCEPTANCE 不能丢失。\n输出要求：RECENT_OUTPUT 简体中文。";
  f.write([message("user", early), message("assistant", Array.from({ length: 20 }, (_, index) =>
    ({ type: "tool_use", name: "Read", id: `read-${index}`, input: { file_path: `src/old-${index}.mjs` } }))), message("user", latest)]);
  const result = f.transfer(["--max-chars", "1000", "--json"]);
  assert.equal(result.code, 0, result.stderr);
  const first = JSON.parse(result.stdout);
  assert.ok(first.handoff.length <= 1000, `实际长度 ${first.handoff.length}`);
  assert.ok(first.handoff.includes(early));
  assert.ok(first.omittedTools > 0);
  assert.equal(first.compressedMessages, 0);
  assert.equal(first.handoff.includes('"src/old-0.mjs"'), false);
  f.write([message("user", "目标：保留早期目标。" + "需要压缩的早期文字。".repeat(400)), message("assistant", "已定决策：保持兼容。"), message("user", latest)]);
  const compressed = f.transfer(["--max-chars", "800", "--json"]);
  assert.equal(compressed.code, 0, compressed.stderr);
  const second = JSON.parse(compressed.stdout);
  assert.ok(second.handoff.length <= 800, `实际长度 ${second.handoff.length}`);
  assert.ok(second.compressedMessages > 0);
  assert.equal(second.omittedTools, 0);
  assert.match(second.handoff, /早期文字已压缩/);
  assert.match(second.handoff, /RECENT_ACCEPTANCE/);
  assert.match(second.handoff, /RECENT_OUTPUT/);
  for (const title of ["目标", "已定决策与约束（含不要做的事）", "涉及文件", "验收标准", "输出要求"])
    assert.ok(second.handoff.includes(`## ${title}`), title);
});

test("转交过滤多行密钥、显式文件全文和文字思考区，不泄露字段后的续行", () => {
  const f = fixture();
  f.write([message("user", "目标：验证隐私过滤。\napiKey: |\n  MULTILINE_PRIVATE_VALUE\n  MULTILINE_PRIVATE_TAIL\n约束：不要改文件。\n文件全文：\nUNFENCED_FILE_BODY\nUNFENCED_FILE_TAIL\n\n验收标准：仍保留验收信息。\n思考过程：\nTHOUGHT_TEXT_BODY\n\n输出要求：只确认收到。"),
    message("assistant", "password: \"QUOTED_PRIVATE_FIRST\nQUOTED_PRIVATE_SECOND\"\n-----BEGIN PRIVATE KEY-----\nPEM_PRIVATE_PAYLOAD\n-----END PRIVATE KEY-----\n决策：保留现有协议。")]);
  const result = f.transfer(["--json"]);
  assert.equal(result.code, 0, result.stderr);
  const all = result.stdout + result.stderr + f.readRecord().stdin;
  for (const secret of ["MULTILINE_PRIVATE_VALUE", "MULTILINE_PRIVATE_TAIL", "UNFENCED_FILE_BODY", "UNFENCED_FILE_TAIL",
    "THOUGHT_TEXT_BODY", "QUOTED_PRIVATE_FIRST", "QUOTED_PRIVATE_SECOND", "PEM_PRIVATE_PAYLOAD"])
    assert.equal(all.includes(secret), false, secret);
  assert.match(all, /不要改文件/);
  assert.match(all, /仍保留验收信息/);
  assert.match(all, /只确认收到/);
  assert.match(all, /保留现有协议/);
});

test("最小预算压缩 Unicode 文字时，返回交接说明与实际发送正文一致", () => {
  const f = fixture();
  f.write([message("user", "目标：x" + "😀".repeat(700) + "END")]);
  const result = f.transfer(["--max-chars", "512", "--json"]);
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.handoff.length <= 512);
  assert.ok(f.readRecord().stdin.startsWith(payload.handoff), "不能切断代理对，造成返回内容与实际 UTF-8 正文不同");
});

test("--source 优先于登记路径，记录损坏或没有文字时不调用 dsh 且不回显内容", () => {
  const f = fixture();
  f.write([message("user", "目标：采用显式来源。")]);
  const selected = f.transfer(["--source", f.source, "--json"], { CLAUDE_TRANSCRIPT_PATH: path.join(f.config, "missing.jsonl") });
  assert.equal(selected.code, 0, selected.stderr);
  assert.match(JSON.parse(selected.stdout).handoff, /采用显式来源/);
  for (const content of ["{BROKEN_PRIVATE_VALUE", "", JSON.stringify(message("user", [{ type: "tool_result", content: "TOOL_ONLY_PRIVATE" }]))]) {
    const invalid = fixture();
    fs.writeFileSync(invalid.source, content);
    const result = invalid.transfer(["--json"]);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /BROKEN_PRIVATE_VALUE|TOOL_ONLY_PRIVATE/);
    assert.equal(fs.existsSync(invalid.record), false);
  }
});

for (const mode of ["no-session", "no-final", "incomplete", "exit-nonzero", "error"]) {
  test(`转交失败（${mode}）不输出伪成功续接命令，也不改变可续接线程`, () => {
    const f = fixture();
    f.write([message("user", "目标：建立线程。")]);
    assert.equal(f.run(["task", "原有任务"], { cwd: f.cwd, env: { FAKE_DSH_THREAD_ID: "kept-thread" } }).code, 0);
    const before = f.run(["task-resume-candidate", "--json"], { cwd: f.cwd }).stdout;
    const result = f.transfer(["--json"], { FAKE_DSH_MODE: mode });
    assert.equal(result.code, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.resumeCommand, undefined);
    assert.match(payload.error, /转交未完成/);
    assert.equal(f.run(["task-resume-candidate", "--json"], { cwd: f.cwd }).stdout, before);
  });
}

test("转交命令手动调用并显式传入登记路径；非法或缺值参数在读取记录前拒绝", () => {
  const f = fixture();
  f.write([message("user", "目标：参数检查。")]);
  for (const flags of [["--source"], ["--cwd"], ["--max-chars"], ["--max-chars", "511"], ["--max-chars", "64001"],
    ["--max-chars", "NaN"], ["--max-chars", "12.5"], ["--background"], ["--resume"], ["额外文字"]]) {
    const result = f.transfer(flags);
    assert.equal(result.code, 2, JSON.stringify(flags) + result.stderr);
    assert.equal(fs.existsSync(f.record), false);
  }
  const command = fs.readFileSync(new URL("../commands/transfer.md", import.meta.url), "utf8");
  assert.match(command, /disable-model-invocation: true/);
  assert.match(command, /CLAUDE_TRANSCRIPT_PATH="\$\{CLAUDE_TRANSCRIPT_PATH\}"/);
  assert.match(command, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/deepseek-host\.mjs" claude transfer \$ARGUMENTS/);
  for (const flag of ["--source", "--max-chars", "--cwd", "--json"]) assert.ok(command.includes(flag));
  assert.match(command, /tui/);
  assert.match(command, /不会.*原 Claude 会话|原 Claude 会话.*不受影响/);
});

test("未按标题书写的对话也保留明确约束、验收和输出要求，Markdown 标题可单独占行", () => {
  const f = fixture();
  f.write([message("user", "请实现分页。不要改公开接口。验收需要 npm test 通过。最终请用中文汇报。"),
    message("assistant", "我们决定采用游标分页。"),
    message("user", "## 涉及文件\nsrc/page.mjs：分页入口\n## 输出要求\n只总结修改与测试结果。")]);
  const result = f.transfer(["--json"]);
  assert.equal(result.code, 0, result.stderr);
  const handoff = JSON.parse(result.stdout).handoff;
  const section = (title, next) => handoff.split(`\n## ${title}\n`)[1].split(next ? `\n## ${next}\n` : "\n本次仅转交")[0];
  assert.match(section("已定决策与约束（含不要做的事）", "涉及文件"), /不要改公开接口/);
  assert.match(section("已定决策与约束（含不要做的事）", "涉及文件"), /决定采用游标分页/);
  assert.match(section("验收标准", "输出要求"), /npm test 通过/);
  assert.match(section("输出要求"), /中文汇报/);
  assert.match(section("输出要求"), /只总结修改与测试结果/);
  assert.match(section("涉及文件", "验收标准"), /src\/page\.mjs/);
});

test("跨文字块的文件正文与 YAML 列表中的多行密钥也必须排除", () => {
  const f = fixture();
  f.write([message("user", [
    { type: "text", text: "目标：检查跨块过滤。\n```txt\n" },
    { type: "text", text: "SPLIT_FULL_FILE_BODY\n```\n约束：保持兼容。" },
  ]), message("assistant", "  - apiKey: |\n      LIST_PRIVATE_VALUE\n      LIST_PRIVATE_TAIL\n输出要求：仅确认。")]);
  const result = f.transfer(["--json"]);
  assert.equal(result.code, 0, result.stderr);
  const all = result.stdout + f.readRecord().stdin;
  for (const secret of ["SPLIT_FULL_FILE_BODY", "LIST_PRIVATE_VALUE", "LIST_PRIVATE_TAIL"])
    assert.equal(all.includes(secret), false, secret);
  assert.match(all, /保持兼容/);
  assert.match(all, /仅确认/);
});

test("带转义引号的密钥与嵌入 file 标签的正文不进入交接说明", () => {
  const f = fixture();
  f.write([message("user", '目标：保留正常目标。\napiKey="ESCAPED_SECRET_LEFT\\"ESCAPED_SECRET_RIGHT"\n<file path="src/secret.mjs">FILE_TAG_FULL_CONTENT</file>\n输出要求：只确认收到。')]);
  const result = f.transfer(["--json"]);
  assert.equal(result.code, 0, result.stderr);
  const all = result.stdout + f.readRecord().stdin;
  for (const value of ["ESCAPED_SECRET_LEFT", "ESCAPED_SECRET_RIGHT", "FILE_TAG_FULL_CONTENT"]) assert.equal(all.includes(value), false, value);
  assert.match(all, /保留正常目标/);
  assert.match(all, /只确认收到/);
});

test("带空格的凭据标签及其多行值不进入交接说明", () => {
  const f = fixture();
  const secrets = ["synthetic-api-private", "synthetic-key-private", "synthetic-client-private", "synthetic-access-private"];
  f.write([message("user", `目标：检查凭据标签。\nAPI Key: ${secrets[0]}\nPrivate Key: |\n  ${secrets[1]}\nClient Secret = "${secrets[2]}"\nAccess Token: >\n  ${secrets[3]}\n输出要求：保留这条正常要求。`)]);
  const result = f.transfer(["--json"]);
  assert.equal(result.code, 0, result.stderr);
  const all = result.stdout + result.stderr + f.readRecord().stdin;
  for (const secret of secrets) assert.equal(all.includes(secret), false, secret);
  assert.match(all, /保留这条正常要求/);
});

test("显式文件全文与思考区中的空行不结束过滤，后续明确章节仍保留", () => {
  const f = fixture();
  const privateText = ["FILE_FIRST_PARAGRAPH", "FILE_SECOND_PARAGRAPH", "THOUGHT_FIRST_PARAGRAPH", "THOUGHT_SECOND_PARAGRAPH"];
  f.write([message("user", `目标：检查完整区块。\n文件全文：\n${privateText[0]}\n\n${privateText[1]}\n\n验收标准：保留明确验收。\n思考过程：\n${privateText[2]}\n\n${privateText[3]}\n\n## 输出要求\n保留明确输出。`)]);
  const result = f.transfer(["--json"]);
  assert.equal(result.code, 0, result.stderr);
  const all = result.stdout + result.stderr + f.readRecord().stdin;
  for (const value of privateText) assert.equal(all.includes(value), false, value);
  assert.match(all, /保留明确验收/);
  assert.match(all, /保留明确输出/);
});

test("Harness 指引标明真实项目根，并提醒先登记工作区再查找线程", () => {
  const f = fixture();
  f.write([message("user", "目标：确认桌面端续接指引。")]);
  const result = f.transfer(["--cwd", path.join(f.cwd, "sub"), "--json"]);
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.harnessInstructions.includes(f.cwd));
  assert.match(payload.harnessInstructions, /登记.*工作区/);
  assert.ok(payload.harnessInstructions.includes(payload.threadId));
  assert.equal(f.readRecord().cwd, f.cwd);
});
