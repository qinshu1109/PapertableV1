import {
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureVerdictTables } from "../src/verdicts.ts";

const command = process.argv[2];
const defaultDatabase = join(
  homedir(),
  "Library",
  "Application Support",
  "Papertable",
  "papertable.sqlite3",
);

if (command === "apply") {
  const databasePath = resolve(process.argv[3] || defaultDatabase);
  if (!existsSync(databasePath) || !statSync(databasePath).isFile()) {
    throw new Error(`数据库不存在：${databasePath}`);
  }
  const backupDir = join(dirname(databasePath), "backups");
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const backupPath = join(
    backupDir,
    `papertable.sqlite3.pre-verdict-ledger-${stamp}.sqlite3`,
  );
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("PRAGMA wal_checkpoint(FULL)");
    db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
    ensureVerdictTables(db);
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length) throw new Error("迁移后存在外键错误，立即使用备份回滚");
    const counts = db.prepare(`
      SELECT status, memos_status, COUNT(*) AS count
      FROM pt_verdicts GROUP BY status, memos_status ORDER BY status, memos_status
    `).all();
    const columns = db.prepare("PRAGMA table_info(pt_verdicts)").all();
    process.stdout.write(`${JSON.stringify({
      ok: true,
      command,
      databasePath,
      backupPath,
      rollback: `node scripts/migrate-verdict-ledger.mjs rollback ${JSON.stringify(backupPath)} ${JSON.stringify(databasePath)}`,
      verdictCounts: counts,
      verdictColumnCount: columns.length,
    })}\n`);
  } finally {
    db.close();
  }
} else if (command === "rollback") {
  const backupPath = resolve(process.argv[3] || "");
  const databasePath = resolve(process.argv[4] || defaultDatabase);
  if (!backupPath || !existsSync(backupPath) || !statSync(backupPath).isFile()) {
    throw new Error("rollback 必须提供存在的备份文件");
  }
  if (!backupPath.includes("papertable.sqlite3.pre-verdict-ledger-")) {
    throw new Error("拒绝使用非判决簿迁移备份执行 rollback");
  }
  const temporary = `${databasePath}.rollback-tmp`;
  copyFileSync(backupPath, temporary);
  renameSync(temporary, databasePath);
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command,
    restoredFrom: backupPath,
    databasePath,
  })}\n`);
} else {
  process.stderr.write(
    "用法：\n"
      + "  node scripts/migrate-verdict-ledger.mjs apply [数据库路径]\n"
      + "  node scripts/migrate-verdict-ledger.mjs rollback <备份路径> [数据库路径]\n",
  );
  process.exitCode = 2;
}
