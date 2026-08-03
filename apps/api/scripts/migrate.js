#!/usr/bin/env node
/**
 * Applies db/migrations/*.sql in filename order, once each, inside a
 * transaction per file. Tracked in schema_migrations.
 *
 *   node scripts/migrate.js            apply pending migrations
 *   node scripts/migrate.js --status   list applied and pending
 */
'use strict';

const { readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Client } = require('pg');

const MIGRATIONS_DIR = join(__dirname, '..', 'db', 'migrations');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
    process.exit(1);
  }

  const client = new Client({ connectionString: url });
  await client.connect().catch((err) => {
    console.error(`Cannot reach PostgreSQL at the configured DATABASE_URL.\n${err.message}`);
    process.exit(1);
  });

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);

    const { rows } = await client.query('SELECT filename FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.filename));

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      // Optional migrations are opt-in: run them explicitly with psql.
      .filter((f) => !f.includes('optional'))
      .sort();

    if (process.argv.includes('--status')) {
      for (const f of files) {
        console.log(`${applied.has(f) ? 'applied ' : 'PENDING '} ${f}`);
      }
      return;
    }

    const pending = files.filter((f) => !applied.has(f));
    if (pending.length === 0) {
      console.log('Database is up to date.');
      return;
    }

    for (const file of pending) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      process.stdout.write(`applying ${file} ... `);
      try {
        // Migration files manage their own BEGIN/COMMIT.
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        console.log('ok');
      } catch (err) {
        console.log('FAILED');
        console.error(err.message);
        process.exit(1);
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
