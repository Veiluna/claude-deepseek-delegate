import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createProcessTracker } from "./process-tracker.mjs";

function fixture() {
  let current = { startTime: "original-instance" };
  const killed = [];
  const tracker = createProcessTracker({
    inspect: () => {
      if (current instanceof Error) throw current;
      return current;
    },
    terminate: (pid, identity) => killed.push({ pid, identity }),
  });
  tracker.track(12345);
  return { tracker, killed, replace: (value) => { current = value; } };
}

test("测试进程 PID 被复用后，原实例保持已退出，不会再次变为存活", () => {
  const f = fixture();
  assert.equal(f.tracker.alive(12345), true);
  f.replace(null);
  assert.equal(f.tracker.alive(12345), false);
  f.replace({ startTime: "reused-instance" });
  assert.equal(f.tracker.alive(12345), false);
});

test("测试夹具善后不能终止复用旧 PID 的新实例", () => {
  const f = fixture();
  f.replace({ startTime: "reused-instance" });
  f.tracker.kill(12345);
  assert.deepEqual(f.killed, []);
});

test("测试夹具仍要求原实例退出，并能清理尚存的原实例", () => {
  const f = fixture();
  assert.equal(f.tracker.alive(12345), true);
  f.tracker.kill(12345);
  assert.deepEqual(f.killed, [{ pid: 12345, identity: { startTime: "original-instance" } }]);
  f.replace(null);
  assert.equal(f.tracker.alive(12345), false);
});

test("测试进程实例查询失败必须报错，不能冒充已退出或继续清理", () => {
  const f = fixture();
  f.replace(new Error("fixture query unavailable"));
  assert.throws(() => f.tracker.alive(12345), /fixture query unavailable/);
  assert.throws(() => f.tracker.kill(12345), /fixture query unavailable/);
  assert.deepEqual(f.killed, []);
});

test("原生测试探针核实真实存活实例，并在清理后确认该实例退出", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  const tracker = createProcessTracker();
  try {
    tracker.track(child.pid);
    assert.equal(tracker.alive(child.pid), true);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    tracker.kill(child.pid);
    await exited;
    assert.equal(tracker.alive(child.pid), false);
  } finally { child.kill("SIGKILL"); }
});
