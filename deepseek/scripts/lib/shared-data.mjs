import fs from "node:fs";
import path from "node:path";
import { withJobsDirectoryLock } from "./jobs.mjs";
import { workspaceDir } from "./state.mjs";

export function assertDirectoryPath(root) {
  for (let current = path.resolve(root); ; current = path.dirname(current)) {
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`不安全的数据目录：${current}`);
    } catch (err) { if (err.code !== "ENOENT") throw err; }
    if (path.dirname(current) === current) break;
  }
}

export function withDataRootLock(root, fn) {
  const resolved = path.resolve(root);
  assertDirectoryPath(resolved);
  const gate = path.join(path.dirname(resolved), `.${path.basename(resolved)}.publish`);
  assertDirectoryPath(gate);
  return withJobsDirectoryLock(gate, fn);
}

export async function prepareSharedProject(root, workspaceRoot) {
  await withDataRootLock(path.join(root, "projects"), () => {
    if (fs.existsSync(root) && (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink())) {
      throw new Error("共享数据目录必须是普通目录。");
    }
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    workspaceDir(workspaceRoot);
  });
}
