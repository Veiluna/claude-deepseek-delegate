import { readFileSync } from "node:fs";

// Minimal flag parser: known value flags consume the next token, everything else
// that starts with "--" is a boolean, and the rest is joined as free text.
export function parseArgs(argv, valueFlags = []) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      if (eq !== -1) {
        flags[name] = token.slice(eq + 1);
      } else if (valueFlags.includes(name)) {
        flags[name] = argv[++i];
      } else {
        flags[name] = true;
      }
      continue;
    }
    positional.push(token);
  }
  return { flags, positional, text: positional.join(" ").trim() };
}

// Slash commands pass "$ARGUMENTS" as one string; split it shell-style.
export function splitRawArgs(argv) {
  if (argv.length !== 1 || !/\s/.test(argv[0])) {
    return argv;
  }
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(argv[0])) !== null) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

// stdin 是任务原文数据，不参与选项拆分，也不删除首尾空白。
export function readPrompt({ flags, positional, text }) {
  if (!("prompt-stdin" in flags)) return text;
  if (flags["prompt-stdin"] !== true) throw new Error("--prompt-stdin 不接受参数值。");
  if (positional.length) throw new Error("--prompt-stdin 与位置正文不能同时指定。");
  let prompt;
  try { prompt = readFileSync(0, "utf8"); }
  catch { throw new Error("读取 stdin 正文失败。"); }
  if (!prompt.trim()) throw new Error("stdin 正文不能为空。");
  return prompt;
}
