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
