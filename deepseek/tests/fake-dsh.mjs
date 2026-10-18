#!/usr/bin/env node
// Fake dsh for tests. Behaviour is driven by FAKE_DSH_MODE; every call is recorded to FAKE_DSH_RECORD.
import fs from "node:fs";

if (process.argv.includes("--version")) {
  if (process.env.FAKE_DSH_MODE === "version-fails") process.exit(2);
  if (process.env.FAKE_DSH_MODE === "hang") process.exit(0);
  process.stdout.write((process.env.FAKE_DSH_VERSION ?? "dsh 0.0.0-fake") + "\n");
  process.exit(0);
}

const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const stdin = Buffer.concat(chunks).toString("utf8");
  if (process.env.FAKE_DSH_RECORD) {
    fs.writeFileSync(process.env.FAKE_DSH_RECORD, JSON.stringify({
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      permissionMode: process.env.DSH_PERMISSION_MODE ?? null,
      stdin,
    }));
  }
  const mode = process.env.FAKE_DSH_MODE || "success";
  const emit = (ev) => process.stdout.write(JSON.stringify(ev) + "\n");
  const finalText = process.env.FAKE_DSH_FINAL ?? "完成：已处理任务";
  if (mode !== "no-session") {
    emit({ type: "session", sessionId: process.env.FAKE_DSH_THREAD_ID ?? "thr_fake_1", cwd: process.cwd() });
  }
  emit({ type: "status", phase: "turn_start" });
  emit({ type: "text", text: "这不是最终回复（截断）：" + "x".repeat(8000) });
  switch (mode) {
    case "no-session":
    case "success":
      emit({ type: "status", phase: "turn_end", reason: { kind: "completed" } });
      emit({ type: "final", text: finalText });
      process.exitCode = 0;
      return;
    case "exit-nonzero":
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
