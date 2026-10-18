import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setup, makeGitRepo } from "./helpers.mjs";

const calls = (t) => fs.existsSync(t.record + ".calls.jsonl")
  ? fs.readFileSync(t.record + ".calls.jsonl", "utf8").trim().split("\n").map(JSON.parse) : [];
const secret = "fake-api-key-do-not-disclose";
const config = [
  "- id: agent-default-model", "  name: model", "  config:",
  "    provider: user-provider", "    model: old-model", "    temperature: 0.25",
  "- id: llm-deepseek", "  config:",
  `    apiKey: '${secret}'`, "    baseURL: https://example.invalid/v1#fragment",
  "    enabled: true", "    retries: 3", "    optional: null",
  "    reasoningEffort: low", "",
].join("\n");

for (const flags of [["--effort", "max"], ["--model", "new-model", "--effort", "max"]]) {
  test(`已有 Agent effort 在任务 patch 中同步覆盖 ${JSON.stringify(flags)}`, () => {
    const t = setup();
    const r = t.run(["task", ...flags, "--json", "--", "任务"], {
      cwd: makeGitRepo(), env: { FAKE_DSH_CONFIG: config.replace("    model: old-model", "    model: old-model\n    reasoningEffort: low") },
    });
    assert.equal(r.code, 0, r.stderr);
    const patch = JSON.parse(t.readRecord().patch);
    assert.deepEqual(patch[0], { id: "agent-default-model", config: {
      provider: "user-provider", model: flags.includes("--model") ? "new-model" : "old-model", reasoningEffort: "max", temperature: 0.25,
    } });
    assert.equal(patch.length, 2);
    assert.equal(patch[1].config.reasoningEffort, "max");
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(secret));
    assertRemoved(t.readRecord());
  });
}

test("仅 effort 且缺少 Agent 条目时仍运行任务", () => {
  const t = setup();
  const r = t.run(["task", "--effort", "off", "--", "任务"], {
    cwd: makeGitRepo(), env: { FAKE_DSH_CONFIG: "- id: llm-deepseek\n" },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(t.readRecord().patch), [{ id: "llm-deepseek", config: { reasoningEffort: "off" } }]);
  assertRemoved(t.readRecord());
});

function assertRemoved(record) {
  assert.ok(record.patchPath);
  assert.equal(fs.existsSync(record.patchPath), false);
  assert.equal(fs.existsSync(path.dirname(record.patchPath)), false);
  if (process.platform !== "win32") {
    assert.equal(record.patchMode, 0o600);
    assert.equal(record.directoryMode, 0o700);
  }
}

test("fake-dsh 拒绝应用参数之后的 launcher --patch", () => {
  for (const application of [["--json"], ["--session-id", "existing-thread"]]) {
    const r = spawnSync(process.execPath, [
      path.resolve("tests/fake-dsh.mjs"), "--profile", "headless", ...application, "--patch", "unused.json", "-",
    ], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown option '--patch'/);
  }
});

for (const [label, flags, expected] of [
  ["model-only", ["--model", "chosen-model"], [{ id: "agent-default-model", config: { provider: "custom-provider", model: "chosen-model" } }]],
  ...["off", "low", "high", "max"].map((effort) => [
    `effort-${effort}`, ["--effort", effort], [{ id: "llm-deepseek", config: { reasoningEffort: effort } }],
  ]),
  ["both", ["--model", "chosen-model", "--effort", "max"], [
    { id: "agent-default-model", config: { provider: "custom-provider", model: "chosen-model" } },
    { id: "llm-deepseek", config: { reasoningEffort: "max" } },
  ]],
]) {
  test(`${label} 写入完整 JSON patch，成功后删除随机目录`, () => {
    const t = setup();
    const repo = makeGitRepo();
    const r = t.run(["task", ...flags, "--json", "--", "执行任务"], { cwd: path.join(repo, "sub") });
    assert.equal(r.code, 0, r.stderr);
    const [dump, task] = calls(t);
    assert.deepEqual(dump.argv, ["--profile", "headless", "--dump-config"]);
    assert.equal(fs.realpathSync(dump.cwd), repo);
    assert.equal(dump.cwd, task.cwd);
    assert.equal(dump.permissionMode, "workspace-write");
    assert.equal(dump.permissionMode, task.permissionMode);
    assert.deepEqual(JSON.parse(task.patch), expected);
    assert.deepEqual(task.argv, ["--profile", "headless", "--patch", task.patchPath, "--json", "-"]);
    assert.ok(task.stdin.startsWith("执行任务\n"));
    assertRemoved(task);
  });
}

for (const mode of ["success", "exit-nonzero"]) {
  test(`合并保留所有原标量字段，${mode} 后删除且不泄露配置`, () => {
    const t = setup();
    const r = t.run(["task", "--model=new-model", "--effort=high", "--read-only", "--json", "--", "任务"], {
      cwd: makeGitRepo(), env: { FAKE_DSH_CONFIG: config, FAKE_DSH_MODE: mode, FAKE_DSH_ECHO_PATCH: "1" },
    });
    assert.equal(r.code, mode === "success" ? 0 : 1, r.stderr);
    const [dump, task] = calls(t);
    assert.equal(dump.permissionMode, "read-only");
    assert.deepEqual(JSON.parse(task.patch), [
      { id: "agent-default-model", config: { provider: "user-provider", model: "new-model", temperature: 0.25 } },
      { id: "llm-deepseek", config: { apiKey: secret, baseURL: "https://example.invalid/v1#fragment", enabled: true, retries: 3, optional: null, reasoningEffort: "high" } },
    ]);
    assertRemoved(task);
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(secret));
    if (mode === "success") {
      const [project] = fs.readdirSync(t.data);
      assert.doesNotMatch(fs.readFileSync(path.join(t.data, project, "state.json"), "utf8"), new RegExp(secret));
    }
  });
}

for (const flags of [["--effort", "medium"], ["--effort=HIGH"], ["--effort="], ["--effort"], ["--model="], ["--model"]]) {
  test(`非法或缺失值 ${JSON.stringify(flags)} 在调用 dsh 前拒绝`, () => {
    const t = setup();
    const r = t.run(["task", "任务", ...flags], { cwd: makeGitRepo() });
    assert.equal(r.code, 2);
    assert.deepEqual(calls(t), []);
  });
}

for (const [name, yaml, exit] of [
  ["dump 失败", config, "3"],
  ["任意文本", secret, "0"],
  ["缺少 model 条目", "- id: llm-deepseek\n", "0"],
  ["嵌套", `- id: agent-default-model\n  config:\n    provider:\n      apiKey: ${secret}\n`, "0"],
  ["多行", `- id: agent-default-model\n  config:\n    provider: |\n      ${secret}\n`, "0"],
  ["无效缩进", "- id: agent-default-model\n  config:\n    provider: first\n   model: second\n", "0"],
  ["重复字段", "- id: agent-default-model\n  config:\n    provider: first\n    provider: second\n", "0"],
  ["重复条目", "- id: agent-default-model\n- id: agent-default-model\n", "0"],
  ["别名", "- id: agent-default-model\n  config: *secret\n", "0"],
  ["目标标签值", `- id: agent-default-model\n  config:\n    provider: !env ${secret}\n`, "0"],
]) {
  test(`${name} 退出且不运行任务、不输出配置`, () => {
    const t = setup();
    const r = t.run(["task", "--model", "new-model", "--", "任务"], {
      cwd: makeGitRepo(), env: { FAKE_DSH_CONFIG: yaml, FAKE_DSH_DUMP_EXIT: exit, FAKE_DSH_DUMP_STDERR: secret },
    });
    assert.equal(r.code, 1);
    assert.equal(calls(t).length, 1);
    assert.ok(calls(t)[0].argv.includes("--dump-config"));
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(secret));
  });
}

test("不指定覆盖时不 dump、不生成 patch，-- 后参数仍是任务正文", () => {
  const t = setup();
  const r = t.run(["task", "--", "任务 --model x --effort max"], { cwd: makeGitRepo(), env: { FAKE_DSH_DUMP_EXIT: "3" } });
  assert.equal(r.code, 0, r.stderr);
  const [task] = calls(t);
  assert.equal(calls(t).length, 1);
  assert.deepEqual(task.argv, ["--profile", "headless", "--json", "-"]);
  assert.equal(task.patchPath, null);
});

test("--resume/--fresh 与覆盖共存，失败不替换可续接线程", () => {
  const t = setup();
  const repo = makeGitRepo();
  assert.equal(t.run(["task", "首次任务"], { cwd: repo }).code, 0);
  for (const route of ["--resume", "--fresh"]) {
    const r = t.run(["task", route, "--model", "new-model", "--effort", "max", "--", "任务"], { cwd: repo });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(t.readRecord().argv.includes("--session-id"), route === "--resume");
    const record = t.readRecord();
    assert.deepEqual(record.argv, ["--profile", "headless", "--patch", record.patchPath, "--json",
      ...(route === "--resume" ? ["--session-id", "thr_fake_1"] : []), "-"]);
    assertRemoved(t.readRecord());
  }
  const before = t.run(["task-resume-candidate", "--json"], { cwd: repo }).stdout;
  const r = t.run(["task", "--resume", "--model", "new-model", "--", "任务"], { cwd: repo, env: { FAKE_DSH_DUMP_EXIT: "3" } });
  assert.equal(r.code, 1);
  assert.equal(t.run(["task-resume-candidate", "--json"], { cwd: repo }).stdout, before);
});

for (const code of ["EPERM", "EBUSY"]) {
  for (const mode of ["success", "exit-nonzero"]) {
    test(`清理 ${code} 保留 ${mode} 任务结果和线程状态`, () => {
      const t = setup();
      const repo = makeGitRepo();
      assert.equal(t.run(["task", "首次任务"], { cwd: repo, env: { FAKE_DSH_THREAD_ID: "previous-thread" } }).code, 0);
      const before = t.run(["task-resume-candidate", "--json"], { cwd: repo }).stdout;
      try {
        const r = t.run(["task", "--fresh", "--model", "new-model", "--json", "--", "任务"], {
          cwd: repo,
          env: { FAKE_DSH_CONFIG: config, FAKE_DSH_MODE: mode, FAKE_DSH_ECHO_PATCH: "1", FAKE_CLEANUP_ERROR: code },
          nodeArgs: ["--import", new URL("./fail-patch-cleanup.mjs", import.meta.url).href],
        });
        assert.equal(r.code, mode === "success" ? 0 : 1, r.stderr);
        const result = JSON.parse(r.stdout);
        assert.equal(result.ok, mode === "success");
        assert.equal(result.exitCode, mode === "success" ? 0 : 3);
        assert.equal(result.final, mode === "success" ? "完成：已处理任务" : null);
        const candidate = t.run(["task-resume-candidate", "--json"], { cwd: repo }).stdout;
        if (mode === "success") assert.equal(JSON.parse(candidate).threadId, "thr_fake_1");
        else assert.equal(candidate, before);
        assert.match(r.stderr, /警告.*临时覆盖目录/);
        assert.ok(r.stderr.includes(path.dirname(t.readRecord().patchPath)));
        assert.doesNotMatch(r.stdout + r.stderr, new RegExp(secret));
      } finally {
        const record = t.readRecord();
        if (record.patchPath) fs.rmSync(path.dirname(record.patchPath), { recursive: true, force: true });
      }
    });
  }
}
