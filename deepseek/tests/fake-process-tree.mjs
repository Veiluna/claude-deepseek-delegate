import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const [record, role] = process.argv.slice(2);
fs.appendFileSync(record, JSON.stringify({ pid: process.pid, role }) + "\n");
if (role !== "grandchild") spawn(process.execPath, [fileURLToPath(import.meta.url), record, role === "worker" ? "child" : "grandchild"], { stdio: "ignore", windowsHide: true });
setInterval(() => {}, 1000);
// 即便测试被强制中断，夹具也会自行退出。
setTimeout(() => process.exit(0), 30000);
