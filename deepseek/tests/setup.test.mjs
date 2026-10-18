import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, makeGitRepo } from "./helpers.mjs";

test("setup reports Node version and where dsh was found", () => {
  const t = setup();
  const r = t.run(["setup", "--json"], { cwd: makeGitRepo() });
  assert.equal(r.code, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.node.version, process.version);
  assert.equal(j.node.ok, true);
  assert.equal(j.dsh.found, true);
  assert.equal(j.dsh.path, t.bin);
});

test("setup reports the dsh version", () => {
  const t = setup();
  const r = t.run(["setup", "--json"], { cwd: makeGitRepo(), env: { FAKE_DSH_VERSION: "dsh 1.2.3" } });
  assert.equal(JSON.parse(r.stdout).dsh.version, "dsh 1.2.3");
});

test("setup runs a minimal read-only task and reports it ready", () => {
  const t = setup();
  const r = t.run(["setup", "--json"], { cwd: makeGitRepo(), env: { FAKE_DSH_FINAL: "OK" } });
  const j = JSON.parse(r.stdout);
  assert.equal(t.readRecord().permissionMode, "read-only");
  assert.equal(j.smoke.ok, true);
  assert.equal(j.smoke.reply, "OK");
  assert.equal(j.ready, true);
  assert.deepEqual(j.suggestions, []);
});

test("setup without dsh skips the task and suggests installing or DSH_BIN", () => {
  const t = setup();
  const repo = makeGitRepo();
  const r = t.run(["setup", "--json"], { cwd: repo, env: { DSH_BIN: repo + "/missing/dsh" } });
  assert.equal(r.code, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.dsh.found, false);
  assert.equal(j.smoke, null);
  assert.equal(j.ready, false);
  assert.match(j.dsh.error, /DSH_BIN 指向的文件不存在/);
  assert.match(j.suggestions.join("\n"), /DSH_BIN/);
});

test("setup suggests logging in to the Harness when the task fails on auth", () => {
  const t = setup();
  const r = t.run(["setup", "--json"], { cwd: makeGitRepo(), env: { FAKE_DSH_MODE: "error" } });
  const j = JSON.parse(r.stdout);
  assert.equal(j.smoke.ok, false);
  assert.equal(j.smoke.error, "not logged in");
  assert.equal(j.ready, false);
  assert.match(j.suggestions.join("\n"), /登录/);
});

test("setup reports other task failures with the raw output and a suggestion", () => {
  const t = setup();
  const r = t.run(["setup", "--json"], { cwd: makeGitRepo(), env: { FAKE_DSH_MODE: "non-json" } });
  const j = JSON.parse(r.stdout);
  assert.equal(j.smoke.ok, false);
  assert.match(j.smoke.output, /this is not json/);
  assert.equal(j.ready, false);
  assert.equal(j.suggestions.length, 1);
  assert.doesNotMatch(j.suggestions[0], /登录/);
});

test("setup tolerates a dsh that cannot report its version", () => {
  const t = setup();
  const r = t.run(["setup", "--json"], { cwd: makeGitRepo(), env: { FAKE_DSH_MODE: "version-fails" } });
  const j = JSON.parse(r.stdout);
  assert.equal(j.dsh.found, true);
  assert.equal(j.dsh.version, null);
});

test("setup prints a readable report without --json", () => {
  const t = setup();
  const r = t.run(["setup"], { cwd: makeGitRepo(), env: { FAKE_DSH_FINAL: "OK", FAKE_DSH_VERSION: "dsh 1.2.3" } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`Node：${process.version.replace(/\./g, "\\.")}`));
  assert.match(r.stdout, /dsh：.*dsh 1\.2\.3/);
  assert.match(r.stdout, /最小任务：通过/);
  assert.match(r.stdout, /可以使用/);
});

test("readable report lists the problem and suggestion when not ready", () => {
  const t = setup();
  const r = t.run(["setup"], { cwd: makeGitRepo(), env: { FAKE_DSH_MODE: "error" } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /最小任务：失败.*not logged in/);
  assert.match(r.stdout, /建议/);
  assert.match(r.stdout, /登录/);
});
