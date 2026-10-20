import { windowsProcessInstance, windowsProcessInstanceAlive } from "./windows-process.mjs";
import { posixProcessInstance, posixProcessInstanceAlive } from "./posix-process.mjs";

const self = new Map();
export function selfProcessInstance() {
  // 一个进程的创建时间不会改变；避免每次状态锁都启动 Windows 查询进程。
  if (!self.has(process.platform)) {
    const instance = process.platform === "win32" ? windowsProcessInstance(process.pid) : posixProcessInstance(process.pid);
    if (!instance) throw new Error("无法核实当前进程的锁持有者身份。");
    self.set(process.platform, instance);
  }
  return self.get(process.platform);
}

export function processInstanceAlive(pid, identity) {
  if (identity?.platform !== process.platform || typeof identity.startTime !== "string") throw new Error("无法核实作业状态锁持有者的进程实例。");
  if (pid === process.pid) {
    const current = selfProcessInstance();
    return current.startTime === identity.startTime && current.bootId === identity.bootId;
  }
  return process.platform === "win32" ? windowsProcessInstanceAlive(pid, identity) : posixProcessInstanceAlive(pid, identity);
}
