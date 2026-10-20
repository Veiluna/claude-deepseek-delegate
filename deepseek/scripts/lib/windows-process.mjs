import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Windows 的原生进程身份查询；仅查询指定 PID，不返回命令行或配置内容。
function inspect(pid, identity, action) {
  const instanceOnly = ["birthtime", "check-birthtime"].includes(action);
  if (!Number.isInteger(pid) || pid <= 0 || (!instanceOnly && (typeof identity?.script !== "string" || !identity.script ||
    !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(identity?.token ?? ""))) ||
    (action === "check-birthtime" && !/^\d+$/.test(identity?.startTime ?? ""))) {
    throw new Error("缺少有效的 Windows 作业进程身份，拒绝终止未经核对的 PID。");
  }
  const script = fs.readFileSync(new URL("./windows-process.ps1", import.meta.url), "utf8");
  const args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
  const options = {
    windowsHide: true, stdio: action === "birthtime" ? ["ignore", "pipe", "ignore"] : "ignore", encoding: "utf8", timeout: 15000,
    env: { ...process.env, DEEPSEEK_TREE_PID: String(pid), DEEPSEEK_TREE_SCRIPT: identity?.script,
      DEEPSEEK_TREE_TOKEN: identity?.token, DEEPSEEK_TREE_BIRTHTIME: identity?.startTime, DEEPSEEK_TREE_ACTION: action,
      DEEPSEEK_JOB_NATIVE: fileURLToPath(new URL("./windows-job-native.cs", import.meta.url)) },
  };
  // PowerShell 7 的冷启动更快；系统未安装时继续使用 Windows 自带版本。
  let r = spawnSync(instanceOnly ? "pwsh.exe" : "powershell.exe", args, options);
  if (instanceOnly && r.error?.code === "ENOENT") r = spawnSync("powershell.exe", args, options);
  if (r.error || ![0, 2, 3].includes(r.status)) throw new Error(`无法核实 Windows 作业进程归属或结束进程树：${pid}`);
  return r;
}

export function windowsProcessAlive(pid, identity) {
  return inspect(pid, identity, "check").status === 0;
}

// 锁持有者可能是普通 companion 进程；只需创建时间，不读取其命令行或凭据。
export function windowsProcessInstance(pid) {
  const r = inspect(pid, null, "birthtime");
  if (r.status === 3) return null;
  const startTime = r.stdout?.trim();
  if (r.status !== 0 || !/^\d+$/.test(startTime ?? "")) throw new Error("无法核实 Windows 锁持有者的进程实例。");
  return { platform: "win32", startTime };
}

export function windowsProcessInstanceAlive(pid, identity) {
  return inspect(pid, identity, "check-birthtime").status === 0;
}

// 与查询失败区分：身份确认不符说明原进程已经退出，不能阻塞作业终态恢复。
export class ProcessIdentityMismatchError extends Error {}

export function killWindowsProcessTree(pid, identity) {
  if (inspect(pid, identity, "kill").status === 2) throw new ProcessIdentityMismatchError(`进程归属不匹配，拒绝终止 PID：${pid}`);
}
