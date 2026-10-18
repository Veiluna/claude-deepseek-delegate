import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { buildPatches, withPatch } from "../scripts/lib/config-patch.mjs";
import { realisticDump } from "./config-dump-fixture.mjs";

test("读取顶层目标条目、引号、注释和标量类型", () => {
  const patches = buildPatches([
    "- id: 'agent-default-model' # comment", "  name: model", "  config:",
    "    provider: 'user''s provider' # comment", '    model: "old"',
    "    temperature: 0.5", "    enabled: false", "    optional: null",
    '- id: "llm-deepseek"', "  name: llm-deepseek", "",
  ].join("\n"), { model: "new", effort: "off" });
  assert.equal(JSON.stringify(patches), JSON.stringify([
    { id: "agent-default-model", config: { provider: "user's provider", model: "new", temperature: 0.5, enabled: false, optional: null } },
    { id: "llm-deepseek", config: { reasoningEffort: "off" } },
  ]));
});

test("混合大小写 null 和布尔字符串在合并后保持原值及类型", () => {
  for (const value of ["nUlL", "nuLL", "nULL", "tRuE", "trUE", "TrUe", "fAlSe", "FaLsE", "FALSe"]) {
    const dump = `- id: agent-default-model\n  config:\n    provider: ${value}\n    model: old\n    reasoningEffort: low\n- id: llm-deepseek\n  config:\n    apiKey: ${value}\n    reasoningEffort: low\n`;
    for (const options of [{ model: "new" }, { effort: "max" }, { model: "new", effort: "max" }]) {
      const expected = [{ id: "agent-default-model", config: {
        provider: value, model: options.model ?? "old", reasoningEffort: options.effort ?? "low",
      } }];
      if (options.effort) expected.push({ id: "llm-deepseek", config: { apiKey: value, reasoningEffort: "max" } });
      assert.deepEqual(buildPatches(dump, options), expected, `${value} ${JSON.stringify(options)}`);
    }
  }
});

test("js-yaml core 的合法 null 和布尔拼写正确识别，其余字符串保留", () => {
  for (const [raw, value] of [
    ["~", null], ["null", null], ["Null", null], ["NULL", null],
    ["true", true], ["True", true], ["TRUE", true],
    ["false", false], ["False", false], ["FALSE", false],
    ["yes", "yes"], ["NO", "NO"], ["on", "on"], ["off", "off"],
    ['"null"', "null"], ["'True'", "True"], ['"FALSE"', "FALSE"],
  ]) {
    const dump = `- id: agent-default-model\n  config:\n    provider: original\n    model: old\n    value: ${raw}\n`;
    assert.deepEqual(buildPatches(dump, { model: "new" }), [
      { id: "agent-default-model", config: { provider: "original", model: "new", value } },
    ], raw);
  }
});

test("受支持的十进制和指数数值在合并后保持 js-yaml 数值类型", () => {
  for (const [raw, value] of [
    ["0", 0], ["+12", 12], ["-42", -42], ["0.5", 0.5], ["-0.25", -0.25],
    ["1e3", 1000], ["1E+3", 1000], ["-2.5e-2", -0.025], ["1e-3", 0.001],
    ["9007199254740991", 9007199254740991],
    ['"123"', "123"], ["'0.5'", "0.5"],
  ]) {
    const dump = `- id: agent-default-model\n  config:\n    model: old\n    value: ${raw}\n`;
    assert.deepEqual(buildPatches(dump, { model: "new" }), [
      { id: "agent-default-model", config: { model: "new", value } },
    ], raw);
  }
});

test("其他 YAML 数值形态及不安全数值继续失败关闭，不改成字符串", () => {
  for (const raw of [
    "0123", "+0123", "-0123", "0x10", "0o10", "0b10", "1_000", "1.", ".5", "-.5",
    ".inf", ".Inf", ".INF", "-.inf", ".nan", ".NaN", ".NAN",
    "1:20", "2026-10-19", "1e309", "9007199254740992", "1efoo",
  ]) {
    const dump = `- id: agent-default-model\n  config:\n    value: ${raw}\n`;
    assert.throws(() => buildPatches(dump, { model: "new" }), /无法安全解析 dsh 配置/, raw);
  }
});

for (const options of [{ model: "new" }, { effort: "max" }, { model: "new", effort: "max" }]) {
  test(`真实形态 dump 的无关语法不影响合并 ${JSON.stringify(options)}`, () => {
    const expected = [];
    if (options.model) expected.push({ id: "agent-default-model", config: { provider: "custom-provider", model: "new" } });
    if (options.effort) expected.push({ id: "llm-deepseek", config: { reasoningEffort: "max" } });
    assert.deepEqual(buildPatches(realisticDump, options), expected);
  });
}

test("只计数顶层目标 id，嵌套目标既不匹配也不造成重复", () => {
  const nested = "- id: group\n  entries:\n    - id: agent-default-model\n      config:\n        model: nested\n";
  assert.throws(() => buildPatches(nested, { model: "new" }));
  assert.equal(buildPatches(nested + realisticDump, { model: "new" })[0].config.provider, "custom-provider");
});

test("带引号的重复顶层目标 id 仍然拒绝", () => {
  for (const [id, options] of [["agent-default-model", { model: "new" }], ["llm-deepseek", { effort: "max" }]]) {
    for (const header of [id, `'${id}'`, `"${id}"`]) {
      assert.throws(() => buildPatches(realisticDump + `- id: ${header}\n`, options));
    }
    assert.throws(() => buildPatches("- id: unrelated\n", options));
  }
});

test("目标条目块在文档结束处停止", () => {
  for (const marker of ["...", "--- # next document"]) {
    const dump = `- id: llm-deepseek\n  name: llm\n${marker}\nunsupported: !env synthetic-secret\n`;
    assert.deepEqual(buildPatches(dump, { effort: "max" }), [{ id: "llm-deepseek", config: { reasoningEffort: "max" } }]);
  }
});

test("不校验无关条目的字符串和缩进，也不校验未覆盖的目标", () => {
  const dump = "- id: unrelated\n\tunknown: 'unterminated\n" +
    "- id: llm-deepseek\n  config: !env synthetic-secret\n" +
    "- id: agent-default-model\n  config:\n    provider: original\n";
  assert.equal(buildPatches(dump, { model: "new" })[0].config.provider, "original");
});

for (const yaml of [
  "not yaml", "- id: agent-default-model\n  config:\n    x: [secret]\n",
  "- id: agent-default-model\n  config:\n    x: |\n      secret\n",
  "- id: agent-default-model\n  config:\n    x:\n      secret: true\n",
  "- id: agent-default-model\n  config:\n    x: first\n    x: secret\n",
  "- id: agent-default-model\n  config:\n    x: 'secret\n      continued'\n",
  "- id: agent-default-model\n  config: *secret\n",
  "- id: agent-default-model\n  config:\n    provider: !env secret\n",
  "- id: agent-default-model\n  config: &secret\n    model: old\n",
  "- id: agent-default-model\n  name: !env secret\n",
  "- id: agent-default-model\n  name: |\n    secret\n",
  "- id: agent-default-model\n  inject:\n    - secret\n",
  "- id: agent-default-model\n  extra:\n    nested: secret\n",
  "- id: agent-default-model\n  config: {}\n",
]) {
  test(`配置拒绝不支持的结构 ${JSON.stringify(yaml)}`, () => {
    assert.throws(() => buildPatches(yaml, { model: "new" }), (error) => {
      assert.doesNotMatch(error.message, /secret/);
      return true;
    });
  });
}

test("只有被覆盖条目要求 config 为扁平标量映射", () => {
  const yaml = "- id: unrelated\n  config:\n    nested:\n      value: x\n    prompt: |\n      - id: agent-default-model\n- id: agent-default-model\n  config:\n    provider: original\n    model: old\n";
  assert.equal(buildPatches(yaml, { model: "new" })[0].config.provider, "original");
});

test("配置树的无关标量数组可以读取，目标 config 中的数组拒绝", () => {
  const yaml = "- id: unrelated\n  config:\n    values:\n      - first\n      - second\n- id: llm-deepseek\n";
  assert.equal(buildPatches(yaml, { effort: "max" })[0].config.reasoningEffort, "max");
  assert.throws(() => buildPatches(yaml.replace("unrelated", "agent-default-model"), { model: "new" }));
});

test("patch 生命周期在成功和异常后都删除整个随机目录", async () => {
  for (const throws of [false, true]) {
    let file;
    const run = withPatch([{ id: "test", config: { model: "new" } }], async (patch) => {
      file = patch;
      assert.equal(fs.existsSync(patch), true);
      assert.equal(fs.readFileSync(patch, "utf8"), '[{"id":"test","config":{"model":"new"}}]');
      assert.equal(path.dirname(path.dirname(patch)), os.tmpdir());
      if (throws) throw new Error("task failed");
      return "done";
    });
    if (throws) await assert.rejects(run, /task failed/);
    else assert.equal(await run, "done");
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(path.dirname(file)), false);
  }
});

test("effort 同步已有的 Agent 字段，与 model 合并为一个完整条目", () => {
  const dump = "- id: agent-default-model\n  config:\n    provider: original\n    model: old\n    reasoningEffort: low\n    temperature: 0.25\n- id: llm-deepseek\n  config:\n    apiKey: synthetic-secret\n    reasoningEffort: low\n";
  for (const effort of ["off", "low", "high", "max"]) {
    for (const model of [undefined, "new"]) {
      assert.deepEqual(buildPatches(dump, { model, effort }), [
        { id: "agent-default-model", config: { provider: "original", model: model ?? "old", reasoningEffort: effort, temperature: 0.25 } },
        { id: "llm-deepseek", config: { apiKey: "synthetic-secret", reasoningEffort: effort } },
      ]);
    }
  }
  assert.deepEqual(buildPatches(dump, { model: "new" }), [
    { id: "agent-default-model", config: { provider: "original", model: "new", reasoningEffort: "low", temperature: 0.25 } },
  ]);
});

test("Agent 没有 effort 键时不新增；仅 effort 时允许缺少 Agent 条目", () => {
  for (const agent of ["", "- id: agent-default-model\n", "- id: agent-default-model\n  config:\n    provider: original\n    model: old\n"]) {
    assert.deepEqual(buildPatches(agent + "- id: llm-deepseek\n", { effort: "max" }), [
      { id: "llm-deepseek", config: { reasoningEffort: "max" } },
    ]);
  }
  assert.deepEqual(buildPatches("- id: agent-default-model\n  config:\n    reasoningEffort: null\n- id: llm-deepseek\n", { effort: "off" }), [
    { id: "agent-default-model", config: { reasoningEffort: "off" } },
    { id: "llm-deepseek", config: { reasoningEffort: "off" } },
  ]);
  assert.throws(() => buildPatches("- id: llm-deepseek\n", { model: "new", effort: "max" }));
});

test("仅 effort 时仍拒绝重复或无法安全读取的 Agent 条目", () => {
  for (const agent of [
    "- id: agent-default-model\n- id: agent-default-model\n",
    "- id: agent-default-model\n  config:\n    reasoningEffort: !env synthetic-secret\n",
  ]) {
    assert.throws(() => buildPatches(agent + "- id: llm-deepseek\n", { effort: "max" }), (error) => {
      assert.doesNotMatch(error.message, /synthetic-secret/);
      return true;
    });
  }
});

for (const code of ["EPERM", "EBUSY"]) {
  for (const outcome of ["success", "failed-result", "throws"]) {
    test(`清理 ${code} 不覆盖任务 ${outcome}，警告不含配置`, async (t) => {
      // 本测试只验证清理控制流；Windows ACL 子进程在此用成功响应代替。
      const acl = process.platform === "win32" ? t.mock.method(childProcess, "spawnSync", (command) => {
        assert.ok(["whoami.exe", "icacls.exe"].includes(command));
        return { status: 0, stdout: "synthetic-user" };
      }) : null;
      syncBuiltinESMExports();
      let warning = "";
      t.mock.method(process.stderr, "write", (chunk) => { warning += chunk; return true; });
      const remove = t.mock.method(fs, "rmSync", () => {
        throw Object.assign(new Error("synthetic-config-secret"), { code });
      });
      const result = { ok: outcome === "success", final: "原任务 final", threadId: "original-thread", exitCode: outcome === "success" ? 0 : 3 };
      const failure = new Error("original task failure");
      let file;
      try {
        const run = withPatch([{ id: "test", config: { apiKey: "synthetic-config-secret" } }], async (patch) => {
          file = patch;
          if (outcome === "throws") throw failure;
          return result;
        });
        if (outcome === "throws") await assert.rejects(run, (error) => error === failure);
        else assert.equal(await run, result);
        assert.equal(remove.mock.callCount(), 1);
        assert.match(warning, /警告.*临时覆盖目录/);
        assert.ok(warning.includes(path.dirname(file)));
        assert.doesNotMatch(warning, /synthetic-config-secret/);
      } finally {
        remove.mock.restore();
        acl?.mock.restore();
        syncBuiltinESMExports();
        if (file) fs.rmSync(path.dirname(file), { recursive: true, force: true });
      }
    });
  }
}
