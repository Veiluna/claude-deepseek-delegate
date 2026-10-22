import fs from "node:fs";
import { createInterface } from "node:readline";

export async function* transcriptRecords(source, host) {
  const input = fs.createReadStream(source, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let readError;
  input.on("error", (error) => { readError = error; lines.close(); });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); }
      catch { throw new Error(`${host} 会话记录存在无效 JSON，未转交任何内容。`); }
      yield record;
    }
    if (readError) throw new Error(`${host} 会话记录读取失败，未转交任何内容。`);
  } finally { lines.close(); input.destroy(); }
}
