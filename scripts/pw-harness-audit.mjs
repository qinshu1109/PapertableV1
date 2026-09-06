#!/usr/bin/env node
/**
 * Paperweight Harness 监督审计（TASK-PW-27）
 *
 * 只读打开真实库，跑 runPwHarnessAudit（擅自发动 + 自主档白名单两条断言），
 * 打印违规明细；有违规 exit 1，零违规 exit 0。不改库。
 *
 * 库路径：PAPERTABLE_DATA_DIR 指向数据目录（缺省 ~/Library/Application Support/Papertable），
 * 数据库文件为该目录下 papertable.sqlite3（与 src/data.ts openDataStore 同语义）。
 *
 * 用法：node scripts/pw-harness-audit.mjs
 *       PAPERTABLE_DATA_DIR=/path/to/data node scripts/pw-harness-audit.mjs
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runPwHarnessAudit } from "../src/pw-supervision.ts";

const dataDir = resolve(
  process.env.PAPERTABLE_DATA_DIR?.trim()
    || join(homedir(), "Library", "Application Support", "Papertable"),
);
const databasePath = join(dataDir, "papertable.sqlite3");

if (!existsSync(databasePath) || !statSync(databasePath).isFile()) {
  console.error(`✗ 数据库不存在：${databasePath}`);
  process.exit(1);
}

const db = new DatabaseSync(databasePath, { readOnly: true });
try {
  const { ok, violations } = runPwHarnessAudit(db);
  console.log(`Harness 监督审计（ai_exec 擅自发动 + ai_auto 自主档白名单）：${violations.length} 条违规`);
  if (violations.length > 0) {
    for (const violation of violations) {
      console.log(`  [${violation.kind}] id=${violation.id} event=${violation.event_type} at=${violation.created_at}`);
      console.log(`    ${violation.reason}`);
    }
    console.error(`✗ 存在 ${violations.length} 条违规，exit 1（店规突破信号，勿改数据，交人处理）`);
    process.exit(1);
  }
  console.log("✓ ok，零违规");
  process.exit(0);
} finally {
  db.close();
}
