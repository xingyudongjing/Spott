import { readFileSync } from 'node:fs';
import { stdout } from 'node:process';
import { Client, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { configuration } from '../../config.js';
import { FieldCrypto } from '../../platform/crypto.js';
import type { VerifiedBFFAuthority } from '../../platform/web-bff-authority.js';
import { IdempotencyService } from '../../platform/idempotency.js';
import {
  AuthService,
  type WebEmailSessionCompletionInput,
} from './auth.service.js';
import { SessionTokenService } from './session-token.service.js';

class ChildProcessDatabaseAdapter {
  constructor(private readonly client: Client) {}

  query<T extends QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.client.query<T>(text, [...values]);
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.client.query('BEGIN');
    await this.client.query("SET LOCAL TIME ZONE 'UTC'");
    try {
      const result = await work(this.client as unknown as PoolClient);
      await this.client.query('COMMIT');
      return result;
    } catch (error) {
      await this.client.query('ROLLBACK');
      throw error;
    }
  }
}

const input = JSON.parse(readFileSync(0, 'utf8')) as WebEmailSessionCompletionInput;
const configuredKid = configuration().REFRESH_TOKEN_DERIVATION_KEYS.currentKid;
const client = new Client({
  connectionString: process.env.SPOTT_TEST_DATABASE_URL,
  application_name: 'spott-web-completion-fresh-process-recovery',
});
const authority: VerifiedBFFAuthority = {
  version: 'v1',
  kid: 'completion-bff',
  timestamp: 1_784_346_245_000,
  nonceHash: Buffer.alloc(32, 17),
};

await client.connect();
try {
  const service = new AuthService(
    new ChildProcessDatabaseAdapter(client) as never,
    new FieldCrypto(),
    new IdempotencyService(),
    new SessionTokenService(),
  );
  await service.completeWebEmailSession(
    input,
    authority,
    'verified_bff',
  );
  const accepted = await service.acceptWebSessionCompletionAttempt(
    input.attemptId,
    {
      challengeId: input.credential.challengeId,
      deviceId: input.deviceId,
      binding: input.newBinding,
    },
    authority,
    'verified_bff',
  );
  if (accepted.state !== 'accepted') {
    throw new Error('Fresh completion process did not accept the pending material');
  }
  const material = accepted.material;
  stdout.write(JSON.stringify({ configuredKid, material }));
} finally {
  await client.end();
}
