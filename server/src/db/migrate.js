import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import 'dotenv/config';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function migrate() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const sql = readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  try {
    await pool.query(sql);
    console.log('Schema applied.');
  } finally {
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
