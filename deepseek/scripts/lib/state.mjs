import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Project root: git top-level, otherwise the given directory.
export function resolveWorkspaceRoot(cwd) {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (r.status === 0 && r.stdout.trim()) {
    return path.resolve(r.stdout.trim());
  }
  return path.resolve(cwd);
}

function dataRoot() {
  return process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), ".claude", "plugins", "data", "deepseek");
}

export function workspaceDir(workspaceRoot) {
  const hash = crypto.createHash("sha1").update(workspaceRoot.toLowerCase()).digest("hex").slice(0, 12);
  const dir = path.join(dataRoot(), `${path.basename(workspaceRoot)}-${hash}`);
  fs.mkdirSync(path.join(dir, "jobs"), { recursive: true });
  return dir;
}

function stateFile(workspaceRoot) {
  return path.join(workspaceDir(workspaceRoot), "state.json");
}

export function loadState(workspaceRoot) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(workspaceRoot), "utf8"));
  } catch {
    return { resumableThread: null };
  }
}

export function saveState(workspaceRoot, state) {
  fs.writeFileSync(stateFile(workspaceRoot), JSON.stringify(state, null, 2));
}

export function updateState(workspaceRoot, fn) {
  const state = loadState(workspaceRoot);
  fn(state);
  saveState(workspaceRoot, state);
  return state;
}
