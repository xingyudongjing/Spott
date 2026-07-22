import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { jobNames, WorkerJobs } from '../src/jobs.js';

const config = parseConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://spott:spott@localhost/spott',
  WORKER_BATCH_SIZE: '1',
});

function result<T>(rows: T[], rowCount = rows.length) {
  return { rows, rowCount };
}

const pending = {
  attempt_hash: randomBytes(32),
  challenge_id: '11111111-1111-4111-8111-111111111111',
  device_id: '22222222-2222-4222-8222-222222222222',
  binding_id: '33333333-3333-4333-8333-333333333333',
  session_id: '44444444-4444-4444-8444-444444444444',
  state: 'pending' as const,
  cleanup_kind: 'pending' as const,
  due_at: new Date('2026-01-02T00:00:00.000Z'),
};

const accepted = {
  ...pending,
  state: 'accepted' as const,
  cleanup_kind: 'terminal' as const,
};

describe('Web session completion cleanup', () => {
  it('is registered as a durable worker responsibility', () => {
    expect(jobNames).toContain('cleanupWebSessionCompletionRecords');
  });

  it('expires one pending disposition only after locking and revoking its exact authority rows', async () => {
    const statements: Array<{ text: string; values: readonly unknown[] }> = [];
    const client = {
      query: async (text: string, values: readonly unknown[] = []) => {
        statements.push({ text, values });
        if (text.includes('FROM identity.web_session_completion_dispositions AS disposition')
          && text.includes('FOR UPDATE SKIP LOCKED')) {
          return text.includes("disposition.state = 'pending'") ? result([pending]) : result([]);
        }
        if (text.trimStart().startsWith('SELECT challenge.id')
          && text.includes('FOR UPDATE SKIP LOCKED')) return result([]);
        if (text.includes('FROM identity.web_session_completion_outcomes AS outcome')
          && text.includes('FOR UPDATE')) {
          return result([{
            challenge_id: pending.challenge_id,
            session_id: pending.session_id,
            device_id: pending.device_id,
            binding_id: pending.binding_id,
          }]);
        }
        if (text.includes('FOR UPDATE OF session, history, binding')) {
          return result([{ session_id: pending.session_id }]);
        }
        if (text.includes('UPDATE identity.session_refresh_history')) {
          return result([{ session_id: pending.session_id }]);
        }
        if (text.includes('UPDATE identity.device_bindings')) {
          return result([{ id: pending.binding_id }]);
        }
        if (text.includes('UPDATE identity.sessions')) {
          return result([{ id: pending.session_id }]);
        }
        if (text.includes('UPDATE identity.web_session_completion_dispositions')) {
          return result([{ attempt_hash: pending.attempt_hash }]);
        }
        throw new Error(`Unexpected SQL: ${text}`);
      },
    };
    const database = {
      transaction: async <T>(work: (value: typeof client) => Promise<T>) => work(client),
    };
    const jobs = new WorkerJobs(database as never, config);

    await expect(jobs.cleanupWebSessionCompletionRecords()).resolves.toEqual({
      processed: 1,
      metadata: {
        pendingDiscarded: 1,
        terminalPurged: 0,
        outcomes: 0,
        challenges: 0,
      },
    });

    const claim = statements.find(
      ({ text }) => text.trimStart().startsWith('SELECT disposition.attempt_hash'),
    );
    expect(claim?.text).toContain("disposition.state = 'pending'");
    expect(claim?.text).toContain('disposition.decision_expires_at <= CURRENT_TIMESTAMP');
    expect(claim?.text).toContain('ORDER BY disposition.decision_expires_at');
    expect(claim?.text).toContain('FOR UPDATE SKIP LOCKED');
    expect(claim?.values).toEqual([]);
    const terminalClaim = statements.find(
      ({ text }) => text.includes("disposition.state IN ('accepted','discarded')")
        && text.includes('FOR UPDATE SKIP LOCKED'),
    );
    expect(terminalClaim?.text).toContain('disposition.retained_until <= CURRENT_TIMESTAMP');
    expect(terminalClaim?.text).toContain('ORDER BY disposition.retained_until');

    const exactLock = statements.find(({ text }) => text.includes('FOR UPDATE OF session, history, binding'));
    expect(exactLock?.text).toContain('history.generation = 0');
    expect(exactLock?.text).toContain('binding.generation = 0');
    expect(exactLock?.text).toContain('session.current_binding_generation = 0');
    expect(exactLock?.values).toEqual([
      pending.session_id,
      pending.binding_id,
      pending.device_id,
    ]);

    const dispositionUpdate = statements.find(
      ({ text }) => text.includes('UPDATE identity.web_session_completion_dispositions'),
    );
    expect(dispositionUpdate?.text).toContain("SET state = 'discarded'");
    expect(dispositionUpdate?.text).toContain("state = 'pending'");
    expect(dispositionUpdate?.text).toContain('decision_expires_at <= clock_timestamp()');
    expect(statements.some(({ text }) => text.includes('DELETE FROM identity.web_session_completion_outcomes')))
      .toBe(false);
  });

  it('fails closed without publishing discarded when exact pending authority diverges', async () => {
    const statements: string[] = [];
    const client = {
      query: async (text: string) => {
        statements.push(text);
        if (text.includes('FROM identity.web_session_completion_dispositions AS disposition')
          && text.includes('FOR UPDATE SKIP LOCKED')) {
          return text.includes("disposition.state = 'pending'") ? result([pending]) : result([]);
        }
        if (text.trimStart().startsWith('SELECT challenge.id')
          && text.includes('FOR UPDATE SKIP LOCKED')) return result([]);
        if (text.includes('FROM identity.web_session_completion_outcomes AS outcome')) {
          return result([{
            challenge_id: pending.challenge_id,
            session_id: pending.session_id,
            device_id: pending.device_id,
            binding_id: pending.binding_id,
          }]);
        }
        if (text.includes('FOR UPDATE OF session, history, binding')) return result([]);
        throw new Error(`Unexpected SQL: ${text}`);
      },
    };
    const database = {
      transaction: async <T>(work: (value: typeof client) => Promise<T>) => work(client),
    };
    const jobs = new WorkerJobs(database as never, config);

    await expect(jobs.cleanupWebSessionCompletionRecords())
      .rejects.toThrow('Pending Web completion authority rows diverged');
    expect(statements.some((text) => text.includes('UPDATE identity.web_session_completion_dispositions')))
      .toBe(false);
  });

  it('purges an accepted disposition, its outcome, and its challenge only after retention', async () => {
    const statements: Array<{ text: string; values: readonly unknown[] }> = [];
    const client = {
      query: async (text: string, values: readonly unknown[] = []) => {
        statements.push({ text, values });
        if (text.includes('FROM identity.web_session_completion_dispositions AS disposition')
          && text.includes('FOR UPDATE SKIP LOCKED')) {
          return text.includes("disposition.state IN ('accepted','discarded')")
            ? result([accepted])
            : result([]);
        }
        if (text.trimStart().startsWith('SELECT challenge.id')
          && text.includes('FOR UPDATE SKIP LOCKED')) return result([]);
        if (text.includes('FROM identity.web_session_completion_outcomes AS outcome')
          && text.includes('FOR UPDATE')) {
          return result([{
            challenge_id: accepted.challenge_id,
            session_id: accepted.session_id,
            device_id: accepted.device_id,
            binding_id: accepted.binding_id,
          }]);
        }
        if (text.includes('(session.revoked_at IS NOT NULL')
          && text.includes('FROM identity.sessions AS session')) {
          return result([{ id: accepted.session_id, inactive: true }]);
        }
        if (text.includes('FROM identity.email_challenges AS challenge')
          && text.includes('FOR UPDATE')) return result([{ id: accepted.challenge_id }]);
        if (text.includes('DELETE FROM identity.web_session_completion_dispositions')) {
          return result([{ attempt_hash: accepted.attempt_hash }]);
        }
        if (text.includes('DELETE FROM identity.web_session_completion_outcomes')) {
          return result([{ challenge_id: accepted.challenge_id }]);
        }
        if (text.includes('DELETE FROM identity.email_challenges')) {
          return result([{ id: accepted.challenge_id }]);
        }
        throw new Error(`Unexpected SQL: ${text}`);
      },
    };
    const database = {
      transaction: async <T>(work: (value: typeof client) => Promise<T>) => work(client),
    };
    const jobs = new WorkerJobs(database as never, config);

    await expect(jobs.cleanupWebSessionCompletionRecords()).resolves.toEqual({
      processed: 1,
      metadata: {
        pendingDiscarded: 0,
        terminalPurged: 1,
        outcomes: 1,
        challenges: 1,
      },
    });

    const deletes = statements
      .filter(({ text }) => text.includes('DELETE FROM identity.'))
      .map(({ text }) => text.match(/DELETE FROM identity\.([a-z_]+)/u)?.[1]);
    expect(deletes).toEqual([
      'web_session_completion_dispositions',
      'web_session_completion_outcomes',
      'email_challenges',
    ]);
    const dispositionDelete = statements.find(
      ({ text }) => text.includes('DELETE FROM identity.web_session_completion_dispositions'),
    );
    expect(dispositionDelete?.text).toContain("state IN ('accepted','discarded')");
    expect(dispositionDelete?.text).toContain('retained_until <= clock_timestamp()');
    expect(dispositionDelete?.text).toContain('active_session.revoked_at IS NULL');
    expect(dispositionDelete?.text).toContain('active_session.expires_at > clock_timestamp()');
  });

  it('retains a challenge when another completion disposition still refers to it', async () => {
    const client = {
      query: async (text: string) => {
        if (text.includes('FROM identity.web_session_completion_dispositions AS disposition')
          && text.includes('FOR UPDATE SKIP LOCKED')) {
          return text.includes("disposition.state IN ('accepted','discarded')")
            ? result([accepted])
            : result([]);
        }
        if (text.trimStart().startsWith('SELECT challenge.id')
          && text.includes('FOR UPDATE SKIP LOCKED')) return result([]);
        if (text.includes('FROM identity.web_session_completion_outcomes AS outcome')
          && text.includes('FOR UPDATE')) {
          return result([{
            challenge_id: accepted.challenge_id,
            session_id: accepted.session_id,
            device_id: accepted.device_id,
            binding_id: accepted.binding_id,
          }]);
        }
        if (text.includes('(session.revoked_at IS NOT NULL')
          && text.includes('FROM identity.sessions AS session')) {
          return result([{ id: accepted.session_id, inactive: true }]);
        }
        if (text.includes('FROM identity.email_challenges AS challenge')
          && text.includes('FOR UPDATE')) return result([{ id: accepted.challenge_id }]);
        if (text.includes('DELETE FROM identity.web_session_completion_dispositions')) {
          return result([{ attempt_hash: accepted.attempt_hash }]);
        }
        if (text.includes('DELETE FROM identity.web_session_completion_outcomes')) {
          return result([{ challenge_id: accepted.challenge_id }]);
        }
        if (text.includes('DELETE FROM identity.email_challenges')) return result([]);
        throw new Error(`Unexpected SQL: ${text}`);
      },
    };
    const database = {
      transaction: async <T>(work: (value: typeof client) => Promise<T>) => work(client),
    };
    const jobs = new WorkerJobs(database as never, config);

    await expect(jobs.cleanupWebSessionCompletionRecords()).resolves.toEqual({
      processed: 1,
      metadata: {
        pendingDiscarded: 0,
        terminalPurged: 1,
        outcomes: 1,
        challenges: 0,
      },
    });
  });

  it('cleans a standalone challenge only when neither an outcome nor a retained disposition refers to it', async () => {
    const challengeId = '55555555-5555-4555-8555-555555555555';
    const statements: Array<{ text: string; values: readonly unknown[] }> = [];
    const client = {
      query: async (text: string, values: readonly unknown[] = []) => {
        statements.push({ text, values });
        if (text.includes('FROM identity.web_session_completion_dispositions AS disposition')
          && text.trimStart().startsWith('SELECT disposition.attempt_hash')) {
          return result([]);
        }
        if (text.includes('FROM identity.email_challenges AS challenge')
          && text.includes('FOR UPDATE SKIP LOCKED')) {
          return text.includes('challenge.verified_at IS NOT NULL')
            ? result([{ id: challengeId, due_at: new Date('2026-01-01T00:00:00.000Z') }])
            : result([]);
        }
        if (text.includes('DELETE FROM identity.email_challenges')) {
          return result([{ id: challengeId }]);
        }
        throw new Error(`Unexpected SQL: ${text}`);
      },
    };
    const database = {
      transaction: async <T>(work: (value: typeof client) => Promise<T>) => work(client),
    };
    const jobs = new WorkerJobs(database as never, config);

    await expect(jobs.cleanupWebSessionCompletionRecords()).resolves.toEqual({
      processed: 1,
      metadata: {
        pendingDiscarded: 0,
        terminalPurged: 0,
        outcomes: 0,
        challenges: 1,
      },
    });
    const claim = statements.find(
      ({ text }) => text.includes('FROM identity.email_challenges AS challenge')
        && text.includes('FOR UPDATE SKIP LOCKED'),
    );
    expect(claim?.text).toContain('identity.web_session_completion_outcomes');
    expect(claim?.text).toContain('identity.web_session_completion_dispositions');
    expect(claim?.text).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('treats a newly inserted sessionless disposition as a safe standalone-cleanup no-op', async () => {
    const challengeId = '66666666-6666-4666-8666-666666666666';
    const client = {
      query: async (text: string) => {
        if (text.trimStart().startsWith('SELECT disposition.attempt_hash')) return result([]);
        if (text.includes('FROM identity.email_challenges AS challenge')
          && text.includes('FOR UPDATE SKIP LOCKED')) {
          return text.includes('challenge.verified_at IS NOT NULL')
            ? result([{ id: challengeId, due_at: new Date('2026-01-01T00:00:00.000Z') }])
            : result([]);
        }
        if (text.includes('DELETE FROM identity.email_challenges')) return result([]);
        throw new Error(`Unexpected SQL: ${text}`);
      },
    };
    const database = {
      transaction: async <T>(work: (value: typeof client) => Promise<T>) => work(client),
    };

    await expect(new WorkerJobs(database as never, config).cleanupWebSessionCompletionRecords())
      .resolves.toEqual({
        processed: 0,
        metadata: {
          pendingDiscarded: 0,
          terminalPurged: 0,
          outcomes: 0,
          challenges: 0,
        },
      });
  });

  it('uses the database-oldest candidate class across fresh batch-size-one workers', async () => {
    const claimOrder: string[] = [];
    let round = 0;
    const client = {
      query: async (text: string) => {
        const normalized = text.trimStart();
        if (normalized.startsWith('SELECT disposition.attempt_hash')) {
          if (text.includes("disposition.state = 'pending'")) {
            claimOrder.push('pending');
            return result([pending]);
          }
          claimOrder.push('terminal');
          return result([]);
        }
        if (normalized.startsWith('SELECT challenge.id')) {
          if (text.includes('challenge.verified_at IS NOT NULL')) {
            claimOrder.push('verified');
            round += 1;
            return result([{
              id: `challenge-${round}`,
              due_at: new Date('2026-01-01T00:00:00.000Z'),
            }]);
          }
          claimOrder.push('expired');
          return result([]);
        }
        if (normalized.startsWith('DELETE FROM identity.email_challenges')) {
          return result([{ id: `challenge-${round}` }]);
        }
        throw new Error(`Unexpected SQL: ${text}`);
      },
    };
    const database = {
      transaction: async <T>(work: (value: typeof client) => Promise<T>) => work(client),
    };
    await new WorkerJobs(database as never, config).cleanupWebSessionCompletionRecords();
    await new WorkerJobs(database as never, config).cleanupWebSessionCompletionRecords();

    expect(claimOrder).toEqual([
      'pending',
      'terminal',
      'verified',
      'expired',
      'pending',
      'terminal',
      'verified',
      'expired',
    ]);
  });
});
