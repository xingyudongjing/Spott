import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// Fixed scrypt cost for stored password digests. Bumping any parameter requires a new encoding
// prefix (the stored string embeds the parameters) plus a rehash-on-login migration.
const SCRYPT_COST = 16_384; // N
const SCRYPT_BLOCK_SIZE = 8; // r
const SCRYPT_PARALLELIZATION = 1; // p
const SALT_BYTES = 16;
const DIGEST_BYTES = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

const storedDigestPattern = new RegExp(
  `^scrypt:${SCRYPT_COST}:${SCRYPT_BLOCK_SIZE}:${SCRYPT_PARALLELIZATION}` +
    `:([0-9a-f]{${SALT_BYTES * 2}}):([0-9a-f]{${DIGEST_BYTES * 2}})$`,
  'u',
);

/**
 * Well-formed digest that matches no password. Verifying against it costs the same scrypt work
 * as a real credential, so unknown-email logins stay timing-indistinguishable from wrong-password
 * logins.
 */
export const DUMMY_PASSWORD_HASH =
  `scrypt:${SCRYPT_COST}:${SCRYPT_BLOCK_SIZE}:${SCRYPT_PARALLELIZATION}` +
  `:${'00'.repeat(SALT_BYTES)}:${'00'.repeat(DIGEST_BYTES)}`;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      DIGEST_BYTES,
      {
        N: SCRYPT_COST,
        r: SCRYPT_BLOCK_SIZE,
        p: SCRYPT_PARALLELIZATION,
        maxmem: SCRYPT_MAXMEM,
      },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

/** Encodes as `scrypt:<N>:<r>:<p>:<salt hex>:<digest hex>` with a fresh random salt. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const digest = await derive(password, salt);
  return (
    `scrypt:${SCRYPT_COST}:${SCRYPT_BLOCK_SIZE}:${SCRYPT_PARALLELIZATION}` +
    `:${salt.toString('hex')}:${digest.toString('hex')}`
  );
}

/**
 * Timing-safe verification: always performs the full scrypt derivation (malformed stored values
 * fall back to the dummy salt) and compares with `timingSafeEqual`.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const match = storedDigestPattern.exec(stored);
  const saltHex = match?.[1] ?? '00'.repeat(SALT_BYTES);
  const expectedHex = match?.[2] ?? 'ff'.repeat(DIGEST_BYTES);
  const expected = Buffer.from(expectedHex, 'hex');
  const derived = await derive(password, Buffer.from(saltHex, 'hex'));
  const equal = expected.byteLength === derived.byteLength && timingSafeEqual(expected, derived);
  return match !== null && equal;
}
