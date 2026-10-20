#!/usr/bin/env node
// Fake dsh for tests. Behaviour is driven by FAKE_DSH_MODE; every call is recorded to FAKE_DSH_RECORD.
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { realisticDump } from "./config-dump-fixture.mjs";

function recordCall(stdin = "") {
  const argv = process.argv.slice(2);
  const patchIndex = argv.indexOf("--patch");
  const patchPath = patchIndex < 0 ? null : argv[patchIndex + 1];
  const record = {
    argv, cwd: process.cwd(), pid: process.pid,
    permissionMode: process.env.DSH_PERMISSION_MODE ?? null,
    stdin,
    patchPath,
    patch: patchPath ? fs.readFileSync(patchPath, "utf8") : null,
    patchMode: patchPath ? fs.statSync(patchPath).mode & 0o777 : null,
    directoryMode: patchPath ? fs.statSync(path.dirname(patchPath)).mode & 0o777 : null,
  };
  if (process.env.FAKE_DSH_RECORD) {
    fs.writeFileSync(process.env.FAKE_DSH_RECORD, JSON.stringify(record));
    fs.appendFileSync(process.env.FAKE_DSH_RECORD + ".calls.jsonl", JSON.stringify(record) + "\n");
  }
}

if (process.argv.includes("--dump-config")) {
  recordCall();
  process.stdout.write(process.env.FAKE_DSH_CONFIG ?? realisticDump);
  process.stderr.write(process.env.FAKE_DSH_DUMP_STDERR ?? "");
  process.exitCode = Number(process.env.FAKE_DSH_DUMP_EXIT ?? 0);
} else {

if (process.argv.includes("--version")) {
  if (process.env.FAKE_DSH_MODE === "version-fails") process.exit(2);
  if (process.env.FAKE_DSH_MODE === "hang") process.exit(0);
  process.stdout.write((process.env.FAKE_DSH_VERSION ?? "dsh 0.0.0-fake") + "\n");
  process.exit(0);
}

// launcher 遇到首个应用参数后，将剩余参数全部交给 headless。
const argv = process.argv.slice(2);
let applicationStart = 0;
while (["--profile", "--patch"].includes(argv[applicationStart])) applicationStart += 2;
if (argv.slice(applicationStart).includes("--patch")) {
  process.stderr.write("error: unknown option '--patch'\n");
  process.exit(1);
}

const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", async () => {
  const stdin = Buffer.concat(chunks).toString("utf8");
  recordCall(stdin);
  const mode = process.env.FAKE_DSH_MODE || "success";
  if (process.env.FAKE_DSH_TREE) {
    spawn(process.execPath, [fileURLToPath(new URL("./fake-process-tree.mjs", import.meta.url)), process.env.FAKE_DSH_TREE, "child"], {
      stdio: "ignore", windowsHide: true,
    });
  }
  if (process.env.FAKE_DSH_ORPHAN_TREE) {
    const tree = process.env.FAKE_DSH_ORPHAN_TREE;
    spawn(process.execPath, [fileURLToPath(new URL("./fake-process-tree.mjs", import.meta.url)), tree, "child"], {
      detached: process.platform === "win32", windowsHide: true,
      stdio: process.platform === "win32" ? "ignore" : ["ignore", "inherit", "inherit"],
      env: process.platform === "win32" ? process.env : {},
    }).unref();
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(tree) || fs.readFileSync(tree, "utf8").trim().split("\n").length < 2) {
      if (Date.now() > deadline) throw new Error("假 dsh 后代未启动。");
      await delay(10);
    }
  }
  const emit = (ev) => process.stdout.write(JSON.stringify(ev) + "\n");
  const finalText = process.env.FAKE_DSH_FINAL ?? "完成：已处理任务";
  if (mode !== "no-session") {
    emit({ type: "session", sessionId: process.env.FAKE_DSH_THREAD_ID ?? "thr_fake_1", cwd: process.cwd() });
  }
  emit({ type: "status", phase: "turn_start" });
  emit({ type: "text", text: "这不是最终回复（截断）：" + "x".repeat(8000) });
  await delay(Number(process.env.FAKE_DSH_DELAY_MS) || 0);
  switch (mode) {
    case "no-session":
    case "success":
      emit({ type: "status", phase: "turn_end", reason: { kind: "completed" } });
      emit({ type: "final", text: finalText });
      process.exitCode = 0;
      return;
    case "exit-nonzero":
      if (process.env.FAKE_DSH_ECHO_PATCH) {
        const index = process.argv.indexOf("--patch");
        const content = fs.readFileSync(process.argv[index + 1], "utf8");
        process.stderr.write(content);
        emit({ type: "error", message: content });
        emit({ type: "text", text: content });
      }
      emit({ type: "status", phase: "turn_end", reason: { kind: "completed" } });
      emit({ type: "final", text: finalText });
      process.stderr.write("boom\n");
      process.exitCode = 3;
      return;
    case "error":
      emit({ type: "error", message: "not logged in" });
      process.exitCode = 1;
      return;
    case "no-final":
      emit({ type: "status", phase: "turn_end", reason: { kind: "completed" } });
      process.exitCode = 0;
      return;
    case "incomplete":
      emit({ type: "status", phase: "turn_end", reason: { kind: "max_turns" } });
      emit({ type: "final", text: "半途而止" });
      process.exitCode = 0;
      return;
    case "missing-reason":
      emit({ type: "final", text: finalText });
      process.exitCode = 0;
      return;
    case "hang":
      setInterval(() => {}, 1000);
      break;
    case "non-json":
      process.stdout.write("this is not json\n");
      process.exitCode = 0;
      return;
  }
});
}
