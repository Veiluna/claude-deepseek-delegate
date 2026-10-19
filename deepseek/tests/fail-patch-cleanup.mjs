// 仅供 --import 加载的测试夹具：让 companion 的临时覆盖目录清理失败。
import fs from "node:fs";
import path from "node:path";

const remove = fs.rmSync;
fs.rmSync = function (target, options) {
  if (path.basename(String(target)).startsWith("deepseek-patch-")) {
    throw Object.assign(new Error("fake-api-key-do-not-disclose"), { code: process.env.FAKE_CLEANUP_ERROR });
  }
  return remove.call(this, target, options);
};
