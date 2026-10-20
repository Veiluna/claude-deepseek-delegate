import fs from "node:fs";
import { spawnSync } from "node:child_process";

export const OWNER_ENV = "DEEPSEEK_JOB_OWNER";
const gone = (err) => ["ENOENT", "ESRCH"].includes(err.code);
const failure = () => new Error("无法核实 POSIX 作业进程实例或进程组归属，未发送信号。");
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

// 只保留身份字段；绝不把 ps 输出或 environ（可能含凭据）放进记录和错误。
function ps(args) {
  const r = spawnSync("ps", args, { encoding: "utf8", timeout: 5000,
    env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"] });
  if (r.error || (r.status !== 0 && !(r.status === 1 && args.includes("-p") && !r.stdout?.trim()))) throw failure();
  return r.stdout || "";
}
function psProcesses() {
  const text = ps(["-A", "-o", "pid=", "-o", "pgid=", "-o", "lstart=", "-o", "state="]);
  if (!text.trim()) throw failure();
  return text.split(/\r?\n/).filter((s) => s.trim()).map((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+((?:\S+\s+){4}\S+)\s+(\S+)\s*$/.exec(line);
    if (!m) throw failure();
    return { pid: Number(m[1]), pgid: Number(m[2]), startTime: m[3].replace(/\s+/g, " "), state: m[4] };
  });
}
function linuxProcess(pid) {
  let text;
  try { text = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); }
  catch (err) { if (gone(err)) return null; throw failure(); }
  const f = text.slice(text.lastIndexOf(") ") + 2).trim().split(/\s+/);
  if (!/^[A-Za-z]$/.test(f[0]) || !/^\d+$/.test(f[19] || "") || !/^\d+$/.test(f[2] || "")) throw failure();
  return { pid, state: f[0], pgid: Number(f[2]), session: Number(f[3]), startTime: f[19] };
}
const live = (p) => p && !/^[ZX]/.test(p.state);
function bootId() {
  if (process.platform !== "linux") return null;
  try { return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); }
  catch { throw failure(); }
}
function current(pid) {
  return process.platform === "linux" ? linuxProcess(pid) : psProcesses().find((p) => p.pid === pid) || null;
}
function same(a, b) {
  return a.startTime === b.startTime && a.pgid === b.pgid && a.session === b.session;
}
function valid(identity) {
  return identity?.platform === process.platform && typeof identity.startTime === "string" &&
    Number.isInteger(identity.pgid) && identity.pgid > 1 && uuid.test(identity.token || "") &&
    (process.platform !== "linux" || (typeof identity.bootId === "string" && identity.bootId.length > 0 && Number.isInteger(identity.session)));
}

export function posixProcessInstance(pid) {
  const p = current(pid);
  return live(p) ? { platform: process.platform, startTime: p.startTime, bootId: bootId() } : null;
}

export function posixProcessInstanceAlive(pid, identity) {
  const p = current(pid);
  return Boolean(live(p) && identity.platform === process.platform && identity.bootId === bootId() && p.startTime === identity.startTime);
}

export function posixProcessIdentity(pid, token) {
  if (!uuid.test(token || "")) throw failure();
  const p = current(pid);
  if (!live(p)) return null;
  return { platform: process.platform, startTime: p.startTime, pgid: p.pgid,
    ...(p.session === undefined ? {} : { session: p.session }), bootId: bootId(), token };
}
export function posixProcessAlive(pid, identity) {
  if (!valid(identity)) throw failure();
  if (identity.bootId !== bootId()) return false;
  const p = current(pid);
  return Boolean(live(p) && same(p, identity) && owner(p) === identity.token);
}
function group(pgid) {
  let processes;
  if (process.platform === "linux") {
    try { processes = fs.readdirSync("/proc").filter((s) => /^\d+$/.test(s)).map((s) => linuxProcess(Number(s))); }
    catch { throw failure(); }
  } else processes = psProcesses();
  return processes.filter((p) => live(p) && p.pgid === pgid);
}
function owner(p) {
  if (process.platform === "linux") {
    try {
      return fs.readFileSync(`/proc/${p.pid}/environ`).toString().split("\0")
        .find((entry) => entry.startsWith(`${OWNER_ENV}=`))?.slice(OWNER_ENV.length + 1);
    } catch (err) { if (gone(err)) return undefined; throw failure(); }
  }
  // BSD/macOS ps -e 展示环境，-ww 不截断；只查询候选进程，不保存命令行。
  const environmentFlag = process.platform === "darwin" ? "-Eww" : "-eww";
  return new RegExp(`(?:^|\\s)${OWNER_ENV}=([^\\s]*)(?:\\s|$)`).exec(ps([environmentFlag, "-p", String(p.pid), "-o", "command="]))?.[1];
}

export function killPosixProcessTree(pid, identity) {
  if (!valid(identity)) throw failure();
  if (identity.bootId !== bootId()) return;
  const leaderBirth = pid === identity.pgid ? identity.startTime : identity.groupLeaderStartTime;
  if (typeof leaderBirth === "string") {
    const leader = current(identity.pgid);
    if (leader && leader.startTime !== leaderBirth) return; // 组长实例已复用，原进程组必已退出。
  }
  const members = group(identity.pgid);
  if (!members.length) return;
  const ownership = members.map(owner);
  if (!ownership.includes(identity.token)) {
    if (ownership.every((token) => token !== undefined)) return; // 该组号现在属于明确标识的其他作业。
    throw failure();
  }
  // 已核实的私有进程组可包含 env -i 后代；明确携带其他作业标识的成员仍拒绝清理。
  if (ownership.some((token) => token !== undefined && token !== identity.token) || members.some((p) => p.session !== identity.session)) throw failure();
  // 发信号前再核对所有成员的实例及组归属，根进程已退出也不能只凭旧 PID。
  const latest = group(identity.pgid);
  if (!latest.length) return;
  if (latest.some((p) => !members.some((old) => old.pid === p.pid && same(old, p)))) throw failure();
  const latestOwnership = latest.map(owner);
  if (!latestOwnership.includes(identity.token) || latestOwnership.some((token) => token !== undefined && token !== identity.token)) throw failure();
  const root = latest.find((p) => p.pid === pid);
  if (root && !same(root, identity)) throw failure();
  try { process.kill(-identity.pgid, "SIGKILL"); }
  catch (err) { if (err.code !== "ESRCH") throw err; }
  // 组不存在就是已退出，绝不退回正 PID：它可能已经被其他进程复用。
}

// 正常结束时先结束同组后代，让继承的管道产生 EOF；宿主排空输出后再由
// worker 用 killTree 结束整个组。此入口只允许仍存活的宿主清理自己的私有组。
export async function cleanPosixDescendants(identity) {
  const pid = process.pid;
  if (!valid(identity) || identity.pgid !== pid || !posixProcessAlive(pid, identity)) throw failure();
  const deadline = Date.now() + 5000;
  for (;;) {
    if (!posixProcessAlive(pid, identity)) throw failure();
    const members = group(pid).filter((p) => p.pid !== pid);
    if (!members.length) return;
    for (const member of members) {
      const token = owner(member);
      if ((token !== undefined && token !== identity.token) || member.session !== identity.session) throw failure();
      const latest = current(member.pid);
      if (!live(latest)) continue;
      if (!same(member, latest)) throw failure();
      // 这是经再次核实的组内实例，不是向历史 PID 的回退。
      try { process.kill(member.pid, "SIGKILL"); }
      catch (err) { if (err.code !== "ESRCH") throw err; }
    }
    if (Date.now() >= deadline) throw failure();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
