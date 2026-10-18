import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setup, makeGitRepo, tmpDir } from "./helpers.mjs";

function platformFixture(platform) {
  const t = setup();
  const cwd = makeGitRepo();
  const root = tmpDir("ds-case-project-");
  const upper = path.join(root, "Team", "repo");
  const lower = path.join(root, "team", "repo");
  fs.mkdirSync(upper, { recursive: true });
  fs.mkdirSync(lower, { recursive: true });
  const preload = path.join(path.dirname(t.data), `platform-${platform}.cjs`);
  // Keep native path and child-process behavior; simulate only the platform identity policy in the CLI child.
  fs.writeFileSync(preload, [
    'require("node:path");',
    'require("node:child_process");',
    `Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });`,
  ].join("\n"));
  const options = { cwd, nodeArgs: ["--require", preload] };
  const query = (project) => {
    const r = t.run(["task-resume-candidate", "--cwd", project, "--json"], options);
    assert.equal(r.code, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  return { t, cwd, upper, lower, options, query };
}

for (const platform of ["win32", "linux", "darwin"]) {
  test(`${platform}：仅大小写不同的项目${platform === "win32" ? "共享" : "隔离"}可续接线程`, () => {
    const { t, upper, lower, query } = platformFixture(platform);
    assert.equal(query(upper).available, false);
    const [upperDirectory] = fs.readdirSync(t.data);
    const upperCandidate = { threadId: "thr_upper", summary: "Team 项目的任务" };
    fs.writeFileSync(path.join(t.data, upperDirectory, "state.json"), JSON.stringify({ resumableThread: upperCandidate }));

    const other = query(lower);
    if (platform === "win32") {
      assert.deepEqual(other, { available: true, ...upperCandidate });
      assert.deepEqual(fs.readdirSync(t.data), [upperDirectory]);
    } else {
      assert.deepEqual(other, { available: false, threadId: null, summary: null });
      const directories = fs.readdirSync(t.data);
      assert.equal(directories.length, 2);
      const lowerDirectory = directories.find((directory) => directory !== upperDirectory);
      const lowerCandidate = { threadId: "thr_lower", summary: "team 项目的任务" };
      fs.writeFileSync(path.join(t.data, lowerDirectory, "state.json"), JSON.stringify({ resumableThread: lowerCandidate }));
      assert.deepEqual(query(lower), { available: true, ...lowerCandidate });
    }
    assert.deepEqual(query(upper), { available: true, ...upperCandidate });
    assert.equal(fs.existsSync(t.record), false);
  });
}

test("win32：续接沿用旧哈希目录并保留已有作业记录", () => {
  const { t, cwd, upper, lower, options, query } = platformFixture("win32");
  // Seed the pre-change on-disk layout, rather than deriving the expected directory from current code.
  const legacyHash = crypto.createHash("sha1").update(path.resolve(upper).toLowerCase()).digest("hex").slice(0, 12);
  const directoryName = `${path.basename(upper)}-${legacyHash}`;
  const legacyDirectory = path.join(t.data, directoryName);
  fs.mkdirSync(path.join(legacyDirectory, "jobs"), { recursive: true });
  const legacyJob = path.join(legacyDirectory, "jobs", "existing-job.json");
  const jobContent = JSON.stringify({ id: "existing-job", status: "completed" });
  fs.writeFileSync(legacyJob, jobContent);
  const candidate = { threadId: "thr_legacy", summary: "已有任务摘要" };
  fs.writeFileSync(path.join(legacyDirectory, "state.json"), JSON.stringify({ resumableThread: candidate }));

  const aliases = [upper, lower, path.relative(cwd, upper)];
  if (process.platform === "win32") {
    aliases.push(upper.replaceAll("\\", "/"));
    aliases.push(upper.replace(/^[a-z]:/i, (drive) => drive.toUpperCase()));
    aliases.push(upper.replace(/^[a-z]:/i, (drive) => drive.toLowerCase()));
  }
  for (const alias of aliases) assert.deepEqual(query(alias), { available: true, ...candidate });
  const r = t.run(["task", "--cwd", lower, "--resume", "--json", "继续旧任务"], {
    ...options, env: { FAKE_DSH_THREAD_ID: "thr_legacy", FAKE_DSH_FINAL: "旧线程上的新任务" },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);
  assert.deepEqual(t.readRecord().argv, ["--profile", "headless", "--json", "--session-id", "thr_legacy", "-"]);
  assert.deepEqual(query(upper), { available: true, threadId: "thr_legacy", summary: "旧线程上的新任务" });
  assert.deepEqual(fs.readdirSync(t.data), [directoryName]);
  assert.equal(fs.readFileSync(legacyJob, "utf8"), jobContent);
});
