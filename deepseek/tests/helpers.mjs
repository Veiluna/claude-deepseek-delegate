import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const COMPANION = path.join(here, "..", "scripts", "deepseek-companion.mjs");
const FAKE = path.join(here, "fake-dsh.mjs");

export function tmpDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// An executable DSH_BIN that runs the fake with node, on any platform.
export function makeFakeDshBin(dir) {
  if (process.platform === "win32") {
    const bin = path.join(dir, "dsh.cmd");
    fs.writeFileSync(bin, `@"${process.execPath}" "${FAKE}" %*\r\n`);
    return bin;
  }
  const bin = path.join(dir, "dsh");
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

export function makeGitRepo() {
  const repo = tmpDir("ds-repo-");
  spawnSync("git", ["init", "-q"], { cwd: repo });
  fs.mkdirSync(path.join(repo, "sub"));
  return repo;
}

export function setup(defaultEnv = {}) {
  const work = tmpDir("ds-test-");
  const bin = makeFakeDshBin(work);
  const record = path.join(work, "record.json");
  const data = path.join(work, "data");
  // Stop git discovery at the temp dir, in case a parent (e.g. the home dir) is a repo.
  const environment = (env) => ({ ...process.env, GIT_CEILING_DIRECTORIES: fs.realpathSync(os.tmpdir()), DSH_BIN: bin, FAKE_DSH_RECORD: record, CLAUDE_PLUGIN_DATA: data, ...defaultEnv, ...env });
  return {
    bin,
    record,
    data,
    readRecord: () => JSON.parse(fs.readFileSync(record, "utf8")),
    run(args, { cwd, env = {}, nodeArgs = [] } = {}) {
      const r = spawnSync(process.execPath, [...nodeArgs, COMPANION, ...args], {
        cwd,
        encoding: "utf8",
        env: environment(env),
      });
      return { code: r.status, stdout: r.stdout, stderr: r.stderr };
    },
    runAsync(args, { cwd, env = {} } = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [COMPANION, ...args], {
          cwd, env: environment(env), stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
    },
  };
}
