import { runDsh } from "./dsh.mjs";
import { updateState } from "./state.mjs";

// 前台任务与作业共用成功判定和可续接线程保存语义。
export async function executeTask(options) {
  const r = await runDsh(options);
  const result = {
    ok: r.ok, threadId: r.threadId, final: r.final, reason: r.reason,
    exitCode: r.exitCode, error: r.error,
    ...(r.ok ? {} : { stdout: r.stdout, stderr: r.stderr }),
  };
  if (r.ok && typeof r.threadId === "string" && r.threadId.trim()) {
    try {
      await updateState(options.cwd, (state) => {
        state.resumableThread = { threadId: r.threadId, summary: r.final.trim().slice(0, 500) };
      });
    } catch (err) {
      const warning = `可续接线程未能保存（线程 ID：${r.threadId}）：${err.message}`;
      result.resumableThreadSaved = false;
      result.warnings = [warning];
      process.stderr.write(`警告：${warning}\n`);
    }
  }
  return { ...r, ...result };
}
