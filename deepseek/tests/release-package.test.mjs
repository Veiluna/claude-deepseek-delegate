import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir } from "./helpers.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("marketplace installation publishes only the complete deepseek 0.2.0 plugin", (t) => {
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
  assert.equal(manifest.version, "0.2.0");
  assert.deepEqual(fs.readdirSync(path.join(plugin, "commands")).sort(), [
    "adversarial-review.md", "cancel.md", "result.md", "review.md",
    "setup.md", "status.md", "task.md", "transfer.md",
  ]);
  for (const file of [
    "agents/deepseek-agent.md", "hooks/hooks.json", "scripts/deepseek-companion.mjs",
    "scripts/deepseek-session.mjs", "scripts/deepseek-worker.mjs", "scripts/lib/dsh.mjs",
  ]) {
    assert.ok(fs.statSync(path.join(plugin, file)).isFile(), `missing installed file: ${file}`);
  }
});

test("release tree no longer contains the retired deepseek-delegate plugin", () => {
  assert.equal(fs.existsSync(path.join(root, "deepseek-delegate")), false);
});
