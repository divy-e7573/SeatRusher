import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

/**
 * Argon2id parameters.
 *
 * OWASP's recommended baseline (19 MiB of memory, 2 iterations, 1 lane). They are
 * deliberately explicit rather than defaults so a reviewer can see the cost, and
 * so a future tuning decision is a one-line diff.
 */
const ARGON_OPTIONS = {
  algorithm: 2, // Argon2id
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Hashes a plaintext password. The returned value is safe to store, never to log. */
export function hashPassword(password: string): Promise<string> {
  return argonHash(password, ARGON_OPTIONS);
}

/**
 * Constant-time verification of a password against a stored Argon2 hash.
 * Returns false (rather than throwing) for malformed hashes so a corrupt row
 * cannot crash the login endpoint.
 */
export async function verifyPassword(hashValue: string, password: string): Promise<boolean> {
  try {
    return await argonVerify(hashValue, password);
  } catch {
    return false;
  }
}
