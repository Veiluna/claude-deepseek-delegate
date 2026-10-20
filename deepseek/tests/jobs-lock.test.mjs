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

for (const code of ["EPERM", "EACCES"]) {
  test(`锁 owner 短暂不可读（${code}）时等待原持锁者释放，不误报失败或并入临界区`, async (t) => {
    const root = tmpDir("ds-lock-read-");
    const oldData = process.env.CLAUDE_PLUGIN_DATA;
    const oldCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.CLAUDE_PLUGIN_DATA = path.join(root, "data");
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(root);
    t.after(() => {
      if (oldData === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = oldData;
      if (oldCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = oldCeiling;
      fs.rmSync(root, { recursive: true, force: true });
    });
    const lock = path.join(workspaceDir(root), "jobs", ".lock");
    let releaseFirst;
    let firstReady;
    let firstActive = false;
    const released = new Promise((resolve) => { releaseFirst = resolve; });
    const ready = new Promise((resolve) => { firstReady = resolve; });
    const first = withJobsLock(root, async () => {
      firstActive = true;
      firstReady();
      await released;
      firstActive = false;
    });
    await ready;
    const readFile = fs.readFileSync;
    let denied = 0;
    t.mock.method(fs, "readFileSync", function (file, ...args) {
      if (path.dirname(String(file)) === lock && !denied) {
        denied++;
        assert.equal(firstActive, true);
        // 模拟 Windows owner 正被关闭或删除的窗口；下一微任务才允许原持有者解锁。
        queueMicrotask(releaseFirst);
        throw Object.assign(new Error("测试模拟锁文件暂时不可读"), { code });
      }
      return readFile.call(this, file, ...args);
    });
    let entered = false;
    const second = withJobsLock(root, () => {
      assert.equal(firstActive, false, "不能凭读取失败回收活锁");
      entered = true;
    });
    try {
      await Promise.all([first, second]);
      assert.equal(denied, 1);
      assert.equal(entered, true);
      assert.equal(fs.existsSync(lock), false);
    } finally {
      releaseFirst();
      await Promise.allSettled([first, second]);
    }
  });
}

for (const code of ["EPERM", "EACCES", "EEXIST", "ENOTEMPTY"]) {
  test(`发布锁遇到 ${code} 而目标已消失时重试发布，不把竞争窗口当作作业失败`, async (t) => {
    const root = tmpDir("ds-lock-rename-");
    const oldData = process.env.CLAUDE_PLUGIN_DATA;
    const oldCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.CLAUDE_PLUGIN_DATA = path.join(root, "data");
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(root);
    t.after(() => {
      if (oldData === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = oldData;
      if (oldCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = oldCeiling;
      fs.rmSync(root, { recursive: true, force: true });
    });
    const lock = path.join(workspaceDir(root), "jobs", ".lock");
    const rename = fs.renameSync;
    let denied = 0;
    t.mock.method(fs, "renameSync", function (source, target) {
      if (String(target) === lock && !denied) {
        denied++;
        assert.equal(fs.existsSync(lock), false, "模拟竞争者已释放目标锁");
        assert.equal(fs.readdirSync(source).length, 1, "尚未发布的 owner 必须仍完整保留");
        throw Object.assign(new Error("测试模拟锁发布窗口"), { code });
      }
      return rename.call(this, source, target);
    });
    let entered = false;
    await withJobsLock(root, () => {
      assert.equal(fs.readdirSync(lock).length, 1, "必须原子发布 owner 后才能进入临界区");
      entered = true;
    });
    assert.equal(denied, 1);
    assert.equal(entered, true);
    assert.equal(fs.existsSync(lock), false);
  });
}
