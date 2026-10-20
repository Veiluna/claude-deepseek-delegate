import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { tmpDir } from "./helpers.mjs";
import { workspaceDir } from "../scripts/lib/state.mjs";
import { withJobsLock } from "../scripts/lib/jobs.mjs";

test("持锁者在发布 owner 前暂停超过回收期限，两个竞争者仍不能同时进入临界区", { timeout: 15000 }, async (t) => {
  const root = tmpDir("ds-lock-publish-");
  const oldData = process.env.CLAUDE_PLUGIN_DATA;
  const oldCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.CLAUDE_PLUGIN_DATA = path.join(root, "data");
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(root);
  const dir = path.join(workspaceDir(root), "jobs");
  const shared = new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT);
  const counters = new Int32Array(shared);
  const contender = new Worker(new URL("./lock-contender.mjs", import.meta.url), { workerData: { root, shared } });
  const exited = once(contender, "exit");
  t.after(async () => {
    await contender.terminate();
    if (oldData === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = oldData;
    if (oldCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = oldCeiling;
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.deepEqual(await once(contender, "message"), ["paused"]);
  const lock = path.join(dir, ".lock");
  // 旧协议暴露的空目录已过回收期限；新协议此时只有未发布的私有目录。
  if (fs.existsSync(lock)) fs.utimesSync(lock, new Date(0), new Date(0));
  await withJobsLock(root, async () => {
    assert.equal(Atomics.add(counters, 1, 1), 0);
    const attempted = once(contender, "message");
    Atomics.store(counters, 0, 1);
    Atomics.notify(counters, 0);
    await attempted; // 旧协议直接 entered；新协议在原子发布时 contended。
    Atomics.sub(counters, 1, 1);
  });
  Atomics.store(counters, 3, 1);
  Atomics.notify(counters, 3);
  assert.deepEqual(await exited, [0]);
  assert.equal(Atomics.load(counters, 2), 0, "暂停的旧持锁者进入了新持锁者的临界区");
  assert.deepEqual(fs.readdirSync(dir), []);
});
