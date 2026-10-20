import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

function git(cwd, args, optional = false) {
  const result = spawnSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd, encoding: "utf8", shell: false, windowsHide: true,
    maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  if (result.error || (!optional && result.status !== 0)) throw new Error(`无法收集 git 审阅范围（${args[0]}）。`);
  return result;
}

function entries(status) {
  const tokens = status.split("\0").filter(Boolean);
  const result = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = { status: tokens[i].slice(0, 2), file: tokens[i].slice(3) };
    if (/[RC]/.test(entry.status)) entry.original = tokens[++i];
    result.push(entry);
  }
  return result;
}

export function collectReviewContext(cwd, { scope = "auto", base } = {}) {
  if (!["auto", "working-tree", "branch"].includes(scope)) throw new Error("--scope 只允许 auto、working-tree、branch。");
  if (base !== undefined && (typeof base !== "string" || !base.trim() || base.startsWith("--"))) throw new Error("--base 必须提供有效的 git 引用。");
  if (base !== undefined && scope === "working-tree") throw new Error("--base 不能与 --scope working-tree 同用。");
  const root = path.resolve(git(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim());
  const status = entries(git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout);
  const head = git(root, ["rev-parse", "--verify", "--quiet", "HEAD"], true);
  if (base !== undefined) scope = "branch";
  else if (scope === "auto") scope = status.length || head.status !== 0 ? "working-tree" : "branch";
  let files;
  let baseRef = null;
  let mergeBase = null;
  if (scope === "working-tree") files = status.map((entry) => entry.file);
  else {
    baseRef = base ?? ["refs/remotes/origin/HEAD", ...["main", "master", "trunk"].flatMap((name) => [`refs/heads/${name}`, `refs/remotes/origin/${name}`])]
      .find((ref) => git(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], true).status === 0);
    if (!baseRef) throw new Error("无法确定基准分支，请提供 --base <引用> 或 --scope working-tree。");
    const baseCommit = git(root, ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`]).stdout.trim();
    mergeBase = git(root, ["merge-base", baseCommit, "HEAD"]).stdout.trim();
    files = git(root, ["diff", "--name-only", "-z", "--no-renames", mergeBase, "HEAD", "--"]).stdout.split("\0").filter(Boolean);
  }
  const diffOptions = ["--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--binary"];
  const sections = [];
  let omittedBytes = 0;
  if (files.length) {
    if (scope === "branch") sections.push("分支差异：\n" + git(root, ["diff", ...diffOptions, mergeBase, "HEAD", "--"]).stdout);
    else {
      sections.push("暂存差异：\n" + git(root, ["diff", ...diffOptions, "--cached", "--"]).stdout);
      sections.push("未暂存差异：\n" + git(root, ["diff", ...diffOptions, "--"]).stdout);
      for (const entry of status.filter((entry) => entry.status === "??")) {
        const absolute = path.join(root, entry.file);
        const stat = fs.lstatSync(absolute);
        let body;
        if (stat.isSymbolicLink()) body = `符号链接目标：${fs.readlinkSync(absolute)}（未读取目标）`;
        else if (!stat.isFile()) body = "非普通文件，未读取。";
        else if (stat.size > 256 * 1024) {
          omittedBytes += stat.size;
          body = `文件大小 ${stat.size} 字节，正文未内联；请在工作区内只读检查。`;
        }
        else {
          const contents = fs.readFileSync(absolute);
          body = contents.includes(0) ? `二进制文件，${contents.length} 字节。` : contents.toString("utf8");
        }
        sections.push(`未跟踪文件 ${JSON.stringify(entry.file)}：\n${body}`);
      }
    }
  }
  const content = sections.join("\n\n");
  return { root, scope, baseRef, mergeBase, status, files: [...new Set(files)], content, diffBytes: Buffer.byteLength(content) + omittedBytes };
}
