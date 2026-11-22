/**
 * 应用增量迁移脚本(db/migrate-*.sql)。
 *
 * 用法:
 *   DATABASE_URL=postgres://... node scripts/migrate.js db/migrate-speed-obby.sql
 *
 * 不带参数时按文件名顺序执行 db/ 下所有 migrate-*.sql。
 * 每个文件都是幂等的,重复执行安全。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbDir = path.join(here, '..', 'db');
const url = process.env.DATABASE_URL;

if (!url) {
  console.error('请设置 DATABASE_URL 环境变量');
  process.exit(1);
}

/** @returns {Promise<string[]>} 要执行的 sql 文件绝对路径 */
async function resolveFiles() {
  const arg = process.argv[2];
  if (arg) return [path.resolve(arg)];
  const entries = await fs.readdir(dbDir);
  return entries
    .filter((name) => /^migrate-.*\.sql$/.test(name))
    .sort()
    .map((name) => path.join(dbDir, name));
}

const client = new pg.Client({ connectionString: url });

try {
  await client.connect();
  const files = await resolveFiles();
  if (files.length === 0) {
    console.log('没有找到 migrate-*.sql');
  }
  for (const file of files) {
    const sql = await fs.readFile(file, 'utf8');
    process.stdout.write(`应用 ${path.basename(file)} … `);
    await client.query(sql);
    console.log('ok');
  }

  // 打印关键结构,确认迁移生效
  const { rows: tables } = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`,
  );
  console.log('\n表:', tables.map((r) => r.table_name).join(', '));

  const { rows: userCols } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users' ORDER BY ordinal_position`,
  );
  console.log('users 列:', userCols.map((r) => r.column_name).join(', '));

  const { rows: petCols } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'pets' ORDER BY ordinal_position`,
  );
  console.log('pets 列:', petCols.map((r) => r.column_name).join(', '));
} catch (err) {
  console.error('\n迁移失败:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
