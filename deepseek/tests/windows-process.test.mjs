import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { isAlive } from "../scripts/lib/jobs.mjs";
import { killTree } from "../scripts/lib/dsh.mjs";

const identity = { script: "C:\\plugin\\scripts\\deepseek-dsh-host.mjs", token: "11111111-1111-4111-8111-111111111111" };
function windowsBoundary(t, result) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  const calls = [];
  t.mock.method(childProcess, "spawnSync", (command, args, options) => {
    calls.push({ command, args, options });
    // 旧实现直接调用 taskkill，没有核对 PID 身份；模拟它会杀错进程。
    return command === "taskkill" ? { status: 0 } : result;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); Object.defineProperty(process, "platform", platform); });
  return calls;
}

test("Windows PID 已被其他进程复用时拒绝终止，不能绕过作业归属核对", (t) => {
  const calls = windowsBoundary(t, { status: 2 });
  assert.throws(() => killTree({ pid: 12345, identity }), /归属不匹配/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.env.DEEPSEEK_TREE_ACTION, "kill");
  assert.equal(calls[0].options.env.DEEPSEEK_TREE_TOKEN, identity.token);
  assert.equal(calls[0].options.env.DEEPSEEK_TREE_SCRIPT, identity.script);
});

test("Windows worker PID 复用不会被误认为原作业还在运行", (t) => {
  windowsBoundary(t, { status: 2 });
  assert.equal(isAlive(12345, identity), false);
});

for (const [label, commandLine, action, code, fail] of [
  ["精确的脚本路径与作业标识", `node "${identity.script}" --deepseek-owner=${identity.token}`, "check", 0],
  ["同名脚本的不同后缀", `node "${identity.script}.other" --deepseek-owner=${identity.token}`, "kill", 2],
  ["不同作业标识", `node "${identity.script}" --deepseek-owner=22222222-2222-4222-8222-222222222222`, "kill", 2],
  ["仅有前缀相同的标识", `node "${identity.script}" --deepseek-owner=${identity.token}extra`, "kill", 2],
  ["不匹配的脚本路径", `node other.mjs --deepseek-owner=${identity.token}`, "kill", 2],
  ["WMI 查询失败", "private-command-line", "kill", 1, true],
]) {
  test(`Windows 原生身份守卫：${label}`, { skip: process.platform !== "win32" }, () => {
    const probe = fs.readFileSync(new URL("./windows-process-probe.ps1", import.meta.url), "utf8");
    const r = childProcess.spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(probe, "utf16le").toString("base64")], {
      stdio: "ignore", windowsHide: true, timeout: 15000,
      env: { ...process.env, DEEPSEEK_TREE_SCRIPT: identity.script, DEEPSEEK_TREE_TOKEN: identity.token,
        DEEPSEEK_TREE_ACTION: action, FAKE_WINDOWS_COMMAND_LINE: commandLine, FAKE_WINDOWS_QUERY_FAIL: fail ? "1" : "0",
        FAKE_WINDOWS_GUARD: fileURLToPath(new URL("../scripts/lib/windows-process.ps1", import.meta.url)) },
    });
    assert.equal(r.status, code, r.error?.message);
  });
}

test("Windows 归属查询失败时不回退到未经核对的 taskkill，也不泄露输出", (t) => {
  const calls = windowsBoundary(t, { status: 1, stderr: "private-command-line" });
  assert.throws(() => killTree({ pid: 12345, identity }), (error) => {
    assert.match(error.message, /无法核实/);
    assert.doesNotMatch(error.message, /private-command-line/);
    return true;
  });
  assert.equal(calls.length, 1);
});

test("Windows 已核对的作业根不存在时允许重复清理", (t) => {
  const calls = windowsBoundary(t, { status: 3 });
  assert.doesNotThrow(() => killTree({ pid: 12345, identity }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.env?.DEEPSEEK_TREE_ACTION, "kill");
});
