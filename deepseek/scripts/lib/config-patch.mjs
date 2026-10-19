import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const invalid = () => new Error("无法安全解析 dsh 配置：只支持目标 config 的扁平标量映射，未启动任务。");
const MULTILINE = Symbol("multiline");

// Restricted reader for dsh's block YAML dump. Unsupported syntax fails closed;
// parser errors never include the (possibly secret) input.
function scalar(raw) {
  if (raw.startsWith('"')) return JSON.parse(raw);
  if (raw.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(raw)) throw invalid();
    return raw.slice(1, -1).replaceAll("''", "'");
  }
  if (!raw || /^[\[\]{}&*!|>@`%?,:'"]/.test(raw) || /:\s/.test(raw)) throw invalid();
  if (/^(?:~|null|Null|NULL)$/.test(raw)) return null;
  if (/^(?:true|True|TRUE|false|False|FALSE)$/.test(raw)) return raw.toLowerCase() === "true";
  if (/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(raw)) {
    const n = Number(raw);
    if (!Number.isFinite(n) || (Number.isInteger(n) && !Number.isSafeInteger(n))) throw invalid();
    return n;
  }
  // Reject other YAML numeric/date forms rather than changing their types.
  if (/^[+\-.\d]/.test(raw)) throw invalid();
  return raw;
}

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === '"' && c === "\\") { i++; continue; }
    if (quote === "'" && c === "'" && line[i + 1] === "'") { i++; continue; }
    if (c === quote) quote = null;
    else if (!quote && (c === '"' || c === "'") && (i === 0 || /[\s:]/.test(line[i - 1]))) quote = c;
    else if (!quote && c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).trimEnd();
  }
  if (quote) throw invalid();
  return line.trimEnd();
}

function readDump(text) {
  const lines = [];
  let blockIndent = null;
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const indent = raw.length - raw.trimStart().length;
    if (blockIndent !== null && indent > blockIndent) continue;
    blockIndent = null;
    if (/\t/.test(raw.slice(0, indent))) throw invalid();
    const content = stripComment(raw.slice(indent));
    if (!content) continue;
    lines.push({ indent, content });
    if (/:\s*[|>][+-]?\d?$/.test(content)) blockIndent = indent + (content.startsWith("- ") ? 2 : 0);
  }
  let cursor = 0;
  function field(object, content, indent) {
    const match = /^([\w.$-]+):(?:\s+(.*))?$/.exec(content);
    if (!match || Object.hasOwn(object, match[1])) throw invalid();
    const [, key, raw] = match;
    if (raw !== undefined) {
      object[key] = /^[|>][+-]?\d?$/.test(raw) ? MULTILINE : scalar(raw);
    } else if (lines[cursor] && (lines[cursor].indent > indent ||
      (lines[cursor].indent === indent && lines[cursor].content.startsWith("- ")))) {
      object[key] = block(lines[cursor].indent);
    } else object[key] = null;
  }
  function block(indent) {
    if (lines[cursor].indent !== indent) throw invalid();
    if (lines[cursor].content.startsWith("- ")) {
      const array = [];
      while (lines[cursor]?.indent === indent && lines[cursor].content.startsWith("- ")) {
        const content = lines[cursor++].content.slice(2);
        if (!/^[\w.$-]+:($|\s)/.test(content)) {
          array.push(scalar(content));
          continue;
        }
        const object = Object.create(null);
        field(object, content, indent + 2);
        while (lines[cursor]?.indent > indent) {
          if (lines[cursor].indent !== indent + 2) throw invalid();
          field(object, lines[cursor++].content, indent + 2);
        }
        array.push(object);
      }
      return array;
    }
    const object = Object.create(null);
    while (lines[cursor]?.indent === indent && !lines[cursor].content.startsWith("- ")) {
      field(object, lines[cursor++].content, indent);
    }
    return object;
  }
  if (!lines.length || lines[0].indent !== 0) throw invalid();
  const root = block(0);
  if (cursor !== lines.length || !Array.isArray(root)) throw invalid();
  return root;
}

function readTarget(dump, id, required = true) {
  const lines = dump.replace(/^\uFEFF/, "").split(/\r?\n/);
  const matches = [];
  for (let start = 0; start < lines.length; start++) {
    const header = /^- id:\s+(.+)$/.exec(lines[start]);
    if (!header) continue;
    let entryId;
    try {
      // Only inspect the header to identify a target. Other entries' contents
      // are opaque, including syntax this restricted reader cannot handle.
      entryId = scalar(stripComment(header[1]));
    } catch {
      continue;
    }
    if (entryId !== id) continue;
    let end = start + 1;
    while (end < lines.length && !/^- /.test(lines[end]) &&
      !/^(?:---|\.\.\.)(?:\s+#.*)?\s*$/.test(lines[end])) end++;
    matches.push(lines.slice(start, end).join("\n"));
  }
  if (!matches.length && !required) return null;
  if (matches.length !== 1) throw invalid();
  const [entry] = readDump(matches[0]);
  // The config mapping is the only supported structure within a target entry.
  if (Object.entries(entry).some(([key, value]) => key !== "config" &&
    (value === MULTILINE || (value !== null && typeof value === "object")))) throw invalid();
  return entry;
}

export function buildPatches(dump, { model, effort }) {
  try {
    const patches = [];
    function configOf(entry) {
      const config = Object.hasOwn(entry, "config") ? entry.config : Object.create(null);
      if (!config || Array.isArray(config) || typeof config !== "object" ||
        Object.values(config).some((v) => v === MULTILINE || (v !== null && typeof v === "object"))) throw invalid();
      return config;
    }
    if (model !== undefined || effort !== undefined) {
      const entry = readTarget(dump, "agent-default-model", model !== undefined);
      if (entry) {
        const config = configOf(entry);
        const overrideEffort = effort !== undefined && Object.hasOwn(config, "reasoningEffort");
        if (model !== undefined || overrideEffort) {
          patches.push({ id: "agent-default-model", config: {
            ...config,
            ...(model !== undefined ? { model } : {}),
            ...(overrideEffort ? { reasoningEffort: effort } : {}),
          } });
        }
      }
    }
    if (effort !== undefined) {
      const config = configOf(readTarget(dump, "llm-deepseek"));
      patches.push({ id: "llm-deepseek", config: { ...config, reasoningEffort: effort } });
    }
    return patches;
  } catch {
    throw invalid();
  }
}

function restrictDirectory(directory) {
  if (process.platform !== "win32") {
    fs.chmodSync(directory, 0o700);
    return;
  }
  // Windows chmod cannot restrict other users. Remove inherited ACEs before
  // writing secrets; the patch then inherits only this user's access.
  const options = { encoding: "utf8", windowsHide: true, timeout: 15000 };
  const identity = spawnSync("whoami.exe", [], options);
  if (identity.error || identity.status !== 0 || !identity.stdout.trim()) throw new Error();
  const acl = spawnSync("icacls.exe", [directory, "/inheritancelevel:r", "/grant:r", `${identity.stdout.trim()}:(OI)(CI)F`], options);
  if (acl.error || acl.status !== 0) throw new Error();
}

export async function withPatch(patches, run) {
  let directory;
  try {
    let file;
    try {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-patch-"));
      restrictDirectory(directory);
      file = path.join(directory, "patch.json");
      fs.writeFileSync(file, JSON.stringify(patches), { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch {
      throw new Error("无法安全创建 dsh 临时覆盖文件，未启动任务。");
    }
    return await run(file);
  } finally {
    if (directory) {
      try {
        fs.rmSync(directory, { recursive: true, force: true });
      } catch {
        process.stderr.write(`警告：删除 dsh 临时覆盖目录失败：${directory}\n`);
      }
    }
  }
}
