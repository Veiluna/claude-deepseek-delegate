// 仅由离线 CLI 夹具预加载；改变时间或拦截公开文件发布边界，不给产品增加测试开关。
import fs from "node:fs";
import path from "node:path";

if (process.env.DEEPSEEK_TEST_CLOCK) {
  const OriginalDate = Date;
  const instant = OriginalDate.parse(process.env.DEEPSEEK_TEST_CLOCK);
  globalThis.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [instant])); }
    static now() { return instant; }
  };
}

if (process.env.DEEPSEEK_TEST_PUBLICATION || process.env.DEEPSEEK_TEST_RESERVATION) {
  const rename = fs.renameSync;
  const barrier = process.env.DEEPSEEK_TEST_PUBLICATION || process.env.DEEPSEEK_TEST_RESERVATION;
  fs.renameSync = function(source, target) {
    const publication = process.env.DEEPSEEK_TEST_PUBLICATION && path.basename(path.dirname(target)) === "jobs" && target.endsWith(".json") && !target.endsWith(".request.json");
    const reservation = process.env.DEEPSEEK_TEST_RESERVATION && path.basename(target) === "session.json";
    if (publication || reservation) {
      fs.writeFileSync(barrier + ".ready", "ready");
      const wait = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(barrier + ".release")) Atomics.wait(wait, 0, 0, 25);
    }
    return rename.call(fs, source, target);
  };
}
