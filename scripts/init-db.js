/**
 * Create the tables from the command line.
 *
 * Usage:
 *   DATABASE_URL=postgres://user:pass@host:5432/db node scripts/init-db.js
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_URL;

if (!url) {
  console.error('Set the DATABASE_URL environment variable first');
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
  console.log('Tables present:');
  for (const row of rows) console.log(`  - ${row.table_name}`);
} catch (err) {
  console.error('Schema creation failed:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
