import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { posixProcessInstance } from "../scripts/lib/posix-process.mjs";

const probe = fs.readFileSync(new URL("./process-tracker.ps1", import.meta.url), "utf8");
const same = (a, b) => a && b && a.startTime === b.startTime && a.bootId === b.bootId;

function windowsProbe(pid, identity, action) {
  const args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(probe, "utf16le").toString("base64")];
  const options = { encoding: "utf8", windowsHide: true, timeout: 15000,
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, TEST_PROCESS_PID: String(pid), TEST_PROCESS_START: identity?.startTime || "", TEST_PROCESS_ACTION: action },
  };
  let r = spawnSync("pwsh.exe", args, options);
  if (r.error?.code === "ENOENT") r = spawnSync("powershell.exe", args, options);
  if (r.error || ![0, 2, 3].includes(r.status)) throw new Error(`无法核实测试进程实例：PID ${pid}`);
  if (action === "capture" && r.status === 0) {
    if (!/^\d+$/.test(r.stdout.trim())) throw new Error(`无效的测试进程创建时间：PID ${pid}`);
    return { startTime: r.stdout.trim() };
  }
  return null;
}

function inspectProcess(pid) {
  return process.platform === "win32" ? windowsProbe(pid, null, "capture") : posixProcessInstance(pid);
}

function terminateProcess(pid, identity) {
  if (process.platform === "win32") return windowsProbe(pid, identity, "kill");
  if (same(inspectProcess(pid), identity)) {
    try { process.kill(pid, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}

export function createProcessTracker({ inspect = inspectProcess, terminate = terminateProcess } = {}) {
  const tracked = new Map();
  const identityOf = (pid) => {
    if (!tracked.has(pid)) throw new Error(`测试进程尚未记录实例：PID ${pid}`);
    return tracked.get(pid);
  };
  return {
    track(...pids) {
      for (const pid of pids) {
        if (!Number.isInteger(pid) || pid <= 0) throw new Error("无效的测试进程 PID。");
        if (tracked.has(pid)) continue;
        const identity = inspect(pid);
        if (!identity) throw new Error("无法记录测试进程实例。");
        tracked.set(pid, identity);
      }
    },
    alive(pid) {
      return Boolean(same(inspect(pid), identityOf(pid)));
    },
    kill(pid) {
      const original = identityOf(pid);
      const current = inspect(pid);
      if (same(current, original)) terminate(pid, original);
    },
  };
}
