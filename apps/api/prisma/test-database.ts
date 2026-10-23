/**
 * Resolves the database URL integration tests run against.
 *
 * Tests must not write into the development database: Phase 1 tests create
 * bookings to prove the partial unique index works, and those rows would corrupt
 * the dev availability counts. Instead every test runs inside its own Postgres
 * schema (`seatrush_test`), which `prisma migrate deploy` creates and seeds on
 * demand. Same database, same migrations, zero interference.
 */

export const TEST_SCHEMA = 'seatrush_test';

function setSchemaParam(url: string, schema: string): string {
  const parsed = new URL(url);
  if (parsed.searchParams.has('schema')) {
    parsed.searchParams.set('schema', schema);
    return parsed.toString();
  }
  parsed.searchParams.set('schema', schema);
  return parsed.toString();
}

/**
 * TEST_DATABASE_URL wins when set (CI and shell overrides); otherwise the dev
 * DATABASE_URL is reused with the schema swapped for the test schema.
 */
export function resolveTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['TEST_DATABASE_URL'];
  if (explicit) {
    return setSchemaParam(explicit, TEST_SCHEMA);
  }
  const base = env['DATABASE_URL'];
  if (!base) {
    throw new Error(
      'Neither TEST_DATABASE_URL nor DATABASE_URL is set. Copy apps/api/.env.example to apps/api/.env first.',
    );
  }
  return setSchemaParam(base, TEST_SCHEMA);
}
