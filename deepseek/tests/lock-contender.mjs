// 测试专用线程：在创建目录之后、发布 owner 之前精确暂停。
import fs from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { withJobsLock } from "../scripts/lib/jobs.mjs";

const counters = new Int32Array(workerData.shared);
const mkdir = fs.mkdirSync;
const rename = fs.renameSync;
let paused = false;
fs.mkdirSync = function (target, ...args) {
  const result = mkdir.call(this, target, ...args);
  if (!paused && (path.basename(String(target)) === ".lock" || path.basename(String(target)).startsWith(".lock-"))) {
    paused = true;
    parentPort.postMessage("paused");
    if (Atomics.wait(counters, 0, 0, 10000) === "timed-out") throw new Error("等待恢复持锁线程超时");
  }
  return result;
};
fs.renameSync = function (...args) {
  try { return rename.apply(this, args); }
  catch (err) {
    if (path.basename(String(args[1])) === ".lock") parentPort.postMessage("contended");
    throw err;
  }
};
await withJobsLock(workerData.root, async () => {
  if (Atomics.add(counters, 1, 1) !== 0) Atomics.store(counters, 2, 1);
  parentPort.postMessage("entered");
  if (Atomics.wait(counters, 3, 0, 10000) === "timed-out") throw new Error("等待竞争者释放锁超时");
  Atomics.sub(counters, 1, 1);
});
