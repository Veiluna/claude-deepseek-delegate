import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setup, makeGitRepo } from "./helpers.mjs";

const entry = fileURLToPath(new URL("../scripts/deepseek-host.mjs", import.meta.url));
const review = { verdict: "approve", summary: "未发现有证据的问题。", findings: [], next_steps: [] };

function fixture(t) {
  const fake = setup();
  const cwd = makeGitRepo();
  const work = path.dirname(fake.data);
  const env = { ...process.env, DEEPSEEK_DATA_DIR: path.join(work, "shared"), CLAUDE_PLUGIN_DATA: fake.data,
    DSH_BIN: fake.bin, FAKE_DSH_RECORD: fake.record, FAKE_DSH_FINAL: JSON.stringify(review),
    GIT_CEILING_DIRECTORIES: fs.realpathSync(os.tmpdir()), CLAUDE_SESSION_ID: "other-host" };
  const run = (args, extra = {}) => {
    const r = spawnSync(process.execPath, [entry, extra.host || "codex",
      ...(extra.sessionId === null ? [] : ["--session-id", extra.sessionId || "review-owner"]), ...args], {
      cwd: extra.cwd || cwd, encoding: "utf8", input: extra.input, env: { ...env, ...extra.env }, windowsHide: true,
    });
    assert.equal(r.error, undefined);
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const git = (...args) => {
    const r = spawnSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd, encoding: "utf8", env, windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const commit = (message) => git("-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgSign=false", "-c", `core.hooksPath=${path.join(cwd, ".git/hooks")}`, "commit", "-qm", message);
  fs.writeFileSync(path.join(cwd, "calc.mjs"), "export const total = 1;\n");
  git("add", "calc.mjs");
  commit("初始提交");
  git("branch", "-M", "main");
  const start = () => run(["session"], { sessionId: null, input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "review-owner", cwd, transcript_path: null }) });
  t.after(() => {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  return { ...fake, cwd, run, git, commit, start };
}

test("Codex 对抗式审阅与预检从 stdin 接收同一关注点原文", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.cwd, "new.txt"), "变更\n");
  const marker = path.join(f.cwd, "must-not-execute");
  const focus = `  关注 '引号\"' \u0060字面量\u0060\r\n$(touch ${marker}) & | ; >\n--model fake\n  `;
  const flags = ["--cwd", path.join(f.cwd, "sub"), "--scope", "working-tree", "--prompt-stdin", "--json"];
  const preview = f.run(["review-context", ...flags], { input: focus });
  assert.equal(preview.code, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).fileCount, 1);
  assert.equal(fs.existsSync(f.record), false);
  const r = f.run(["adversarial-review", ...flags], { input: focus });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).review, review);
  assert.ok(f.readRecord().stdin.includes(`附加关注点：${JSON.stringify(focus)}\n`));
  assert.equal(f.readRecord().cwd, f.cwd);
  assert.equal(f.readRecord().permissionMode, "read-only");
  assert.equal(fs.existsSync(marker), false);
});

for (const [name, flags, input, error] of [
  ["空输入", ["--prompt-stdin"], "", /stdin 正文不能为空/],
  ["只有空白", ["--prompt-stdin"], " \r\n\t", /stdin 正文不能为空/],
  ["混用位置正文", ["--prompt-stdin", "--", "关注点"], "原文", /位置正文不能同时指定/],
  ["空位置正文", ["--prompt-stdin", "--", ""], "原文", /位置正文不能同时指定/],
  ["带值标志", ["--prompt-stdin=false"], "原文", /不接受参数值/],
]) {
  test(`审阅 stdin 拒绝${name}，预检与两个执行入口均不调用 dsh`, (t) => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.cwd, "new.txt"), "变更");
    for (const command of ["review-context", "review", "adversarial-review"]) {
      const r = f.run([command, ...flags], { input });
      assert.equal(r.code, 2, `${command}: ${r.stderr}`);
      assert.match(r.stderr, error);
      assert.equal(fs.existsSync(f.record), false);
    }
  });
}

test("普通审阅拒绝 stdin 关注点，旧位置关注点语义保持兼容", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.cwd, "new.txt"), "变更");
  const refused = f.run(["review", "--prompt-stdin", "--json"], { input: "附加关注点" });
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /普通审阅不接收附加关注点/);
  assert.equal(fs.existsSync(f.record), false);
  const legacy = f.run(["adversarial-review", "--json", "--", "  旧位置", "关注点  "]);
  assert.equal(legacy.code, 0, legacy.stderr);
  assert.ok(f.readRecord().stdin.includes('附加关注点："旧位置 关注点"\n'));
});

test("Codex 审阅预检识别空范围和未跟踪规模，不启动 dsh", (t) => {
  const f = fixture(t);
  const preview = () => {
    const r = f.run(["review-context", "--json"], { sessionId: null });
    assert.equal(r.code, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  assert.equal(preview().empty, true);
  for (const kind of ["review", "adversarial-review"]) {
    const r = f.run([kind, "--json"], { sessionId: null });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).empty, true);
    assert.match(JSON.parse(r.stdout).message, /没有可审阅的变更/);
  }
  fs.writeFileSync(path.join(f.cwd, "one.txt"), "小变更");
  assert.equal(preview().suggestedMode, "foreground");
  fs.writeFileSync(path.join(f.cwd, "two.txt"), "第二个变更");
  assert.equal(preview().suggestedMode, "foreground");
  fs.writeFileSync(path.join(f.cwd, "three.txt"), "第三个变更");
  assert.equal(preview().fileCount, 3);
  assert.equal(preview().suggestedMode, "background");
  for (const name of ["two.txt", "three.txt"]) fs.unlinkSync(path.join(f.cwd, name));
  fs.writeFileSync(path.join(f.cwd, "one.txt"), "大".repeat(100000));
  const large = preview();
  assert.equal(large.fileCount, 1);
  assert.ok(large.diffBytes >= 300000);
  assert.equal(large.suggestedMode, "background");
  assert.equal(fs.existsSync(f.record), false);
});

test("Codex 两种审阅沿用共同祖先与工作树范围、只读根目录和共享候选", (t) => {
  const f = fixture(t);
  assert.equal(f.run(["task", "--fresh", "--", "原任务"], { host: "claude" }).code, 0);
  const candidate = f.run(["task-resume-candidate", "--json"]).stdout;
  f.git("checkout", "-qb", "feature");
  fs.writeFileSync(path.join(f.cwd, "calc.mjs"), "export const branchOnly = 2;\n");
  f.git("add", "calc.mjs");
  f.commit("分支前进");
  f.git("checkout", "-q", "main");
  fs.writeFileSync(path.join(f.cwd, "main.txt"), "独立主线内容");
  f.git("add", "main.txt");
  f.commit("主线前进");
  f.git("checkout", "-q", "feature");
  fs.writeFileSync(path.join(f.cwd, "calc.mjs"), "export const staged = 3;\n");
  f.git("add", "calc.mjs");
  fs.writeFileSync(path.join(f.cwd, "calc.mjs"), "export const unstaged = 4;\n");
  fs.writeFileSync(path.join(f.cwd, "new.txt"), "未跟踪正文");
  const before = f.git("status", "--porcelain=v1", "-z");
  for (const kind of ["review", "adversarial-review"]) {
    for (const flags of [[], ["--scope", "branch"], ["--base", "main"]]) {
      const r = f.run([kind, ...flags, "--cwd", path.join(f.cwd, "sub"), "--json"], {
        sessionId: null, env: { DSH_PERMISSION_MODE: "workspace-write" },
      });
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout).review, review);
      const record = f.readRecord();
      assert.equal(record.permissionMode, "read-only");
      assert.equal(record.cwd, f.cwd);
      assert.deepEqual(record.argv, ["--profile", "headless", "--json", "-"]);
      assert.equal(record.patch, null);
      if (!flags.length) {
        for (const text of ["staged = 3", "unstaged = 4", "未跟踪正文"]) assert.ok(record.stdin.includes(text));
      } else {
        assert.match(record.stdin, /审阅范围：branch/);
        assert.match(record.stdin, /branchOnly = 2/);
        assert.doesNotMatch(record.stdin, /独立主线内容|未跟踪正文|staged = 3|unstaged = 4/);
      }
    }
  }
  assert.equal(f.git("status", "--porcelain=v1", "-z"), before);
  assert.equal(f.run(["task-resume-candidate", "--json"]).stdout, candidate);
});

test("Codex 预检和执行以相同规则拒绝非法范围与模型参数", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.cwd, "new.txt"), "变更");
  for (const flags of [["--scope", "staged"], ["--base", "missing-ref"], ["--base", "main", "--scope", "working-tree"],
    ["--scope"], ["--base"], ["--cwd"], ["--model"], ["--effort", "medium"]]) {
    for (const kind of ["review-context", "review", "adversarial-review"]) {
      const r = f.run([kind, ...flags, "--json"]);
      assert.notEqual(r.code, 0, JSON.stringify([kind, ...flags]));
      assert.ok(r.stderr.trim());
      assert.equal(fs.existsSync(f.record), false);
    }
  }
});

test("Codex 审阅仅按次覆盖 model/effort，临时配置失败保持输出保护", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.cwd, "new.txt"), "变更");
  const model = "model $HOME & 'quoted'";
  const r = f.run(["review", "--model", model, "--effort", "max", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const rec = f.readRecord();
  const patch = JSON.parse(rec.patch);
  assert.equal(patch.find(p => p.id === "agent-default-model").config.model, model);
  assert.equal(patch.find(p => p.id === "llm-deepseek").config.reasoningEffort, "max");
  assert.equal(rec.permissionMode, "read-only");
  assert.equal(fs.existsSync(rec.patchPath), false);
  const failed = f.run(["review", "--model", model, "--json"], { env: { FAKE_DSH_MODE: "exit-nonzero", FAKE_DSH_ECHO_PATCH: "1" } });
  assert.equal(failed.code, 1);
  const result = JSON.parse(failed.stdout);
  assert.equal(result.final, null);
  assert.equal(result.review, null);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.match(result.error, /原始输出已隐藏/);
  assert.equal(f.run(["review", "--json"]).code, 0);
  assert.equal(f.readRecord().patch, null);
});

for (const [mode, final, reason] of [["success", "不是 JSON", "completed"], ["no-final", null, "completed"],
  ["incomplete", "半途而止", "max_turns"], ["exit-nonzero", JSON.stringify(review), "completed"], ["error", null, null]]) {
  test(`Codex 审阅 ${mode} 失败保留结果，不把截断进度当 final 或替换候选`, (t) => {
    const f = fixture(t);
    assert.equal(f.run(["task", "--fresh", "既有任务"]).code, 0);
    const candidate = f.run(["task-resume-candidate", "--json"]).stdout;
    fs.writeFileSync(path.join(f.cwd, "new.txt"), "变更");
    const r = f.run(["review", "--json"], { env: { FAKE_DSH_MODE: mode, FAKE_DSH_FINAL: final || "无效进度不能补全" } });
    assert.equal(r.code, 1, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.ok, false);
    assert.equal(result.review, null);
    assert.equal(result.final, final);
    assert.equal(result.reason, reason);
    if (mode === "success") assert.match(result.error, /schema.*JSON/);
    if (mode === "exit-nonzero") { assert.equal(result.exitCode, 3); assert.match(result.stderr, /boom/); }
    if (mode === "error") assert.match(result.error, /not logged in/);
    assert.match(result.stdout, /这不是最终回复/);
    assert.equal(f.run(["task-resume-candidate", "--json"]).stdout, candidate);
  });
}

test("Codex 后台审阅要求真实登记，所属结果保留结构与原始失败且候选不变", (t) => {
  const f = fixture(t);
  assert.equal(f.run(["task", "--fresh", "原任务"]).code, 0);
  const candidate = f.run(["task-resume-candidate", "--json"]).stdout;
  fs.writeFileSync(path.join(f.cwd, "new.txt"), "变更");
  const before = fs.readFileSync(f.record, "utf8");
  const unregistered = f.run(["review", "--background", "--json"]);
  assert.equal(unregistered.code, 1);
  assert.match(unregistered.stderr, /SessionStart/);
  assert.equal(fs.readFileSync(f.record, "utf8"), before);
  const registered = f.start();
  assert.equal(registered.code, 0, registered.stderr);
  for (const [kind, final] of [["review", JSON.stringify(review)], ["adversarial-review", "原始非 JSON 回复"]]) {
    const focus = "  关注锁恢复\n--scope branch  ";
    const r = f.run([kind, "--background", "--json", ...(kind === "adversarial-review" ? ["--prompt-stdin"] : [])], {
      input: kind === "adversarial-review" ? focus : undefined,
      env: { FAKE_DSH_FINAL: final, FAKE_DSH_DELAY_MS: "500" },
    });
    assert.equal(r.code, 0, r.stderr);
    const job = JSON.parse(r.stdout);
    assert.equal(job.kind, kind);
    try {
      const done = f.run(["status", job.id, "--wait", "--timeout-ms", "20000", "--json"]);
      assert.equal(done.code, 0, done.stderr);
      assert.equal(JSON.parse(done.stdout).status, kind === "review" ? "completed" : "failed");
      assert.equal(f.readRecord().permissionMode, "read-only");
      assert.equal(f.readRecord().cwd, f.cwd);
      const taken = f.run(["result", job.id, "--json"]);
      assert.equal(taken.code, 0, taken.stderr);
      const result = JSON.parse(taken.stdout);
      assert.equal(result.final, final);
      assert.deepEqual(result.review, kind === "review" ? review : null);
      const text = f.run(["result", job.id]);
      assert.match(text.stdout, kind === "review" ? /结论：approve/ : /schema.*JSON/);
      if (kind === "adversarial-review") {
        assert.match(text.stdout, /原始非 JSON 回复/);
        assert.ok(f.readRecord().stdin.includes(`附加关注点：${JSON.stringify(focus)}\n`));
      }
      const other = f.run(["result", job.id, "--json"], { host: "claude" });
      assert.equal(other.code, 1);
      assert.equal(other.stdout, "");
      assert.equal(f.run(["task-resume-candidate", "--json"]).stdout, candidate);
    } finally { f.run(["cancel", job.id, "--json"]); }
  }
});
