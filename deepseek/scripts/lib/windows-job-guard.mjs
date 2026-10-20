import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Job Object 的存活句柄留在独立 PowerShell 守护进程中。宿主活着时不丢失
// 已成为孤儿的后代；宿主/守护进程退出时 KILL_ON_JOB_CLOSE 负责兜底清理。
export async function windowsJobGuard(identity) {
  const script = fs.readFileSync(new URL("./windows-job-guard.ps1", import.meta.url), "utf8");
  async function launch(command) {
    const helper = spawn(command, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, DEEPSEEK_GUARD_PID: String(process.pid), DEEPSEEK_GUARD_SCRIPT: identity.script, DEEPSEEK_GUARD_TOKEN: identity.token,
        DEEPSEEK_JOB_NATIVE: fileURLToPath(new URL("./windows-job-native.cs", import.meta.url)) },
    });
    let pending = "";
    let waiting;
    let failure;
    const fail = (error) => { failure = error; waiting?.reject(error); };
    const wait = (expected) => new Promise((resolve, reject) => {
      if (failure) { reject(failure); return; }
      const timer = setTimeout(() => { fail(new Error("Windows 作业守护进程未响应。")); helper.kill(); }, 15000);
      waiting = { expected, resolve: () => { clearTimeout(timer); waiting = undefined; resolve(); }, reject: (err) => { clearTimeout(timer); waiting = undefined; reject(err); } };
    });
    helper.stdin.on("error", () => {});
    helper.on("error", fail);
    helper.on("exit", () => fail(new Error("Windows 作业守护进程提前退出。")));
    helper.stdout.setEncoding("utf8");
    helper.stdout.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) if (line === waiting?.expected) waiting.resolve();
    });
    await wait("ready");
    return { clean: () => { const done = wait("cleaned"); helper.stdin.write("clean\n"); return done; } };
  }
  try { return await launch("pwsh.exe"); }
  catch (err) { if (err.code !== "ENOENT") throw err; return launch("powershell.exe"); }
}
