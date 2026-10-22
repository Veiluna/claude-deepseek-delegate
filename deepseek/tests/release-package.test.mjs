import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import os from "node:os";
import { tmpDir, setup } from "./helpers.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("marketplace installation publishes only the complete deepseek 0.3.5 plugin", (t) => {
  const marketplace = readJson(path.join(root, ".claude-plugin", "marketplace.json"));
  const installed = tmpDir("ds-release-");
  t.after(() => fs.rmSync(installed, { recursive: true, force: true }));

  // Install exactly the local sources the marketplace advertises, including dotfiles.
  for (const entry of marketplace.plugins) {
    fs.cpSync(path.resolve(root, entry.source), path.join(installed, entry.name), { recursive: true });
  }
  assert.deepEqual(fs.readdirSync(installed), ["deepseek"]);

  const plugin = path.join(installed, "deepseek");
  const manifest = readJson(path.join(plugin, ".claude-plugin", "plugin.json"));
  assert.equal(manifest.name, "deepseek");
  assert.equal(manifest.version, "0.3.5");
  assert.deepEqual(fs.readdirSync(path.join(plugin, "commands")).sort(), [
    "adversarial-review.md", "cancel.md", "result.md", "review.md",
    "setup.md", "status.md", "task.md", "transfer.md",
  ]);
  // Claude 默认发现根 skills/；同名 skill 会优先于 commands/，不能泄漏 Codex 入口。
  for (const command of fs.readdirSync(path.join(plugin, "commands"))) {
    const name = path.basename(command, ".md");
    assert.equal(fs.existsSync(path.join(plugin, "skills", name, "SKILL.md")), false,
      `Claude command ${name} 被根 skills/ 中的同名 skill 覆盖`);
  }
  for (const file of [
    "agents/deepseek-agent.md", "hooks/hooks.json", "scripts/deepseek-companion.mjs",
    "scripts/deepseek-session.mjs", "scripts/deepseek-worker.mjs", "scripts/lib/dsh.mjs",
    "scripts/deepseek-host.mjs", "scripts/lib/host-context.mjs", "scripts/lib/migration.mjs", "scripts/lib/shared-data.mjs",
    "scripts/lib/codex-transcript.mjs", "scripts/lib/transcript-records.mjs",
  ]) {
    assert.ok(fs.statSync(path.join(plugin, file)).isFile(), `missing installed file: ${file}`);
  }
});

test("Codex marketplace 安装包发现任务、作业、显式审阅与转交 skills、真实钩子且从包内运行核心", (t) => {
  const marketplace = readJson(path.join(root, ".agents", "plugins", "marketplace.json"));
  assert.equal(marketplace.name, "deepseek-delegate");
  assert.equal(marketplace.plugins.length, 1);
  const entry = marketplace.plugins[0];
  assert.equal(entry.name, "deepseek");
  assert.equal(entry.source.source, "local");
  const installed = tmpDir("ds-codex-package-");
  const fake = setup();
  t.after(() => {
    fs.rmSync(installed, { recursive: true, force: true });
    fs.rmSync(path.dirname(fake.data), { recursive: true, force: true });
  });
  const plugin = path.join(installed, entry.name);
  fs.cpSync(path.resolve(root, entry.source.path), plugin, { recursive: true });
  const manifest = readJson(path.join(plugin, ".codex-plugin", "plugin.json"));
  assert.equal(manifest.name, "deepseek");
  assert.equal(manifest.version, "0.3.5");
  assert.equal(manifest.version, readJson(path.join(plugin, ".claude-plugin", "plugin.json")).version);
  assert.equal(manifest.skills, "./codex-skills/");
  assert.deepEqual(fs.readdirSync(path.join(plugin, manifest.skills)).sort(), ["adversarial-review", "cancel", "result", "review", "setup", "status", "task", "transfer"]);
  for (const name of ["setup", "task", "status", "result", "cancel", "review", "adversarial-review", "transfer"]) {
    const skill = fs.readFileSync(path.join(plugin, manifest.skills, name, "SKILL.md"), "utf8");
    assert.match(skill, new RegExp(`^---\\r?\\nname: ${name}\\r?\\n`));
  }
  const transfer = fs.readFileSync(path.join(plugin, manifest.skills, "transfer/SKILL.md"), "utf8");
  assert.match(transfer, /用户显式调用/);
  assert.match(transfer, /\.\.\/\.\.\/references\/codex-cli\.md/);
  for (const flag of ["--source", "--max-chars", "--cwd", "--json"]) assert.ok(transfer.includes(flag));
  assert.match(transfer, /final_answer/);
  assert.match(transfer, /CODEX_HOME/);
  assert.match(transfer, /仅.*确认收到.*等待/);
  assert.match(fs.readFileSync(path.join(plugin, manifest.skills, "transfer/agents/openai.yaml"), "utf8"),
    /^policy:\r?\n  allow_implicit_invocation: false\s*$/);
  for (const name of ["review", "adversarial-review"]) {
    const policy = fs.readFileSync(path.join(plugin, manifest.skills, name, "agents/openai.yaml"), "utf8");
    assert.match(policy, /^policy:\r?\n  allow_implicit_invocation: false\s*$/);
    const skill = fs.readFileSync(path.join(plugin, manifest.skills, name, "SKILL.md"), "utf8");
    assert.match(skill, /用户显式调用/);
    assert.match(skill, /review-context/);
    for (const reference of ["codex-cli.md", "codex-review.md"]) assert.ok(skill.includes(`../../references/${reference}`));
    const workflow = fs.readFileSync(path.join(plugin, "references/codex-review.md"), "utf8");
    for (const flag of ["--base", "--scope", "--model", "--effort", "--background", "--cwd", "--json"]) assert.ok(workflow.includes(flag), `${name} 缺少 ${flag}`);
    assert.match(workflow, /一次/);
    assert.match(workflow, /64 KiB/);
    assert.match(workflow, /未跟踪/);
    assert.match(workflow, /没有可审阅的变更/);
    assert.match(workflow, /final/);
  }
  const hooks = readJson(path.join(plugin, manifest.hooks)).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ["SessionEnd", "SessionStart"]);
  for (const event of Object.values(hooks)) assert.deepEqual(event, [{ hooks: [{ type: "command", command: 'node "${PLUGIN_ROOT}/scripts/deepseek-host.mjs" codex session' }] }]);
  assert.ok(fs.statSync(path.join(plugin, "scripts/lib/host-owner.mjs")).isFile());
  const task = fs.readFileSync(path.join(plugin, manifest.skills, "task/SKILL.md"), "utf8");
  assert.match(task, /--background/);
  assert.doesNotMatch(task, /尚未提供作业入口/);
  const r = spawnSync(process.execPath, [path.join(plugin, "scripts", "deepseek-host.mjs"),
    "codex", "--session-id", "installed-codex-session", "setup", "--json"], {
    cwd: installed, encoding: "utf8", env: {
      ...process.env, DEEPSEEK_DATA_DIR: path.join(installed, "shared"),
      DSH_BIN: fake.bin, FAKE_DSH_RECORD: fake.record,
      GIT_CEILING_DIRECTORIES: fs.realpathSync(os.tmpdir()),
    },
  });
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.ready, true);
  assert.equal(report.hostContext.host, "codex");
  assert.equal(report.hostContext.sessionId, "installed-codex-session");
  assert.equal(fake.readRecord().permissionMode, "read-only");
  const codexHome = path.join(installed, "codex-home");
  fs.mkdirSync(path.join(codexHome, "sessions"), { recursive: true });
  const source = path.join(codexHome, "sessions", "installed.jsonl");
  const id = "11111111-1111-4111-8111-111111111111";
  const original = [
    { type: "session_meta", payload: { id, session_id: id, cwd: installed, source: "vscode" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "目标：INSTALLED_TRANSFER" }] } },
  ].map(record => JSON.stringify(record)).join("\n");
  fs.writeFileSync(source, original);
  const transferred = spawnSync(process.execPath, [path.join(plugin, "scripts", "deepseek-host.mjs"),
    "codex", "transfer", "--source", source, "--json"], {
    cwd: installed, encoding: "utf8", env: { ...process.env, CODEX_HOME: codexHome,
      DEEPSEEK_DATA_DIR: path.join(installed, "shared"), DSH_BIN: fake.bin, FAKE_DSH_RECORD: fake.record,
      GIT_CEILING_DIRECTORIES: fs.realpathSync(os.tmpdir()) },
  });
  assert.equal(transferred.status, 0, transferred.stderr);
  assert.match(JSON.parse(transferred.stdout).handoff, /INSTALLED_TRANSFER/);
  assert.equal(fake.readRecord().permissionMode, "read-only");
  assert.equal(fs.readFileSync(source, "utf8"), original);
});

test("release tree no longer contains the retired deepseek-delegate plugin", () => {
  assert.equal(fs.existsSync(path.join(root, "deepseek-delegate")), false);
});
