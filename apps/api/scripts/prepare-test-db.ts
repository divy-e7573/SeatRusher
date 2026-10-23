/**
 * One command that makes the test database ready: apply migrations to the
 * isolated seatrush_test schema, then seed it with the same demo data the dev
 * database has.
 *
 * Used locally (`pnpm --filter api db:test:prepare`) and in CI before `pnpm test`.
 */

import { spawnSync } from 'node:child_process';
import { config as loadDotenvFile } from 'dotenv';
import { seedDatabase } from '../prisma/seed.js';
import { resolveTestDatabaseUrl } from '../prisma/test-database.js';

loadDotenvFile({ quiet: true });

const testUrl = resolveTestDatabaseUrl(process.env);
console.log(`Preparing test database (schema=${new URL(testUrl).searchParams.get('schema')})`);

const migrate = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
  env: { ...process.env, DATABASE_URL: testUrl },
  stdio: 'inherit',
  shell: true,
});

if (migrate.status !== 0) {
  console.error('prisma migrate deploy failed for the test database');
  process.exit(migrate.status ?? 1);
}

const result = await seedDatabase(testUrl);
console.log(
  `Test database ready: seats=${result.seatCount} shows=${result.showIds.length} ` +
    `(url ${testUrl.replace(/:[^:@/]+@/, ':***@')})`,
);
