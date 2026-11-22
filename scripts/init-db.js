/**
 * 建表脚本(本地/CI 用)。
 *
 * 用法:
 *   DATABASE_URL=postgres://user:pass@host:5432/db node scripts/init-db.js
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_URL;

if (!url) {
  console.error('请设置 DATABASE_URL 环境变量');
  process.exit(1);
}

const sql = await fs.readFile(path.join(here, '..', 'db', 'init.sql'), 'utf8');
const client = new pg.Client({ connectionString: url });

try {
  await client.connect();
  await client.query(sql);
  const { rows } = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`,
  );
  console.log('已创建/确认的表:');
  for (const row of rows) console.log(`  - ${row.table_name}`);
} catch (err) {
  console.error('建表失败:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
