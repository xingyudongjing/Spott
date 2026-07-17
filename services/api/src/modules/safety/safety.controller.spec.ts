import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { SafetyController } from './safety.controller.js';

const user = {
  id: '019b0000-0000-7000-8000-000000000001',
  sessionId: 'session',
  phoneVerified: true,
  restrictions: [],
  roles: ['verified'],
};

describe('SafetyController report reliability contract', () => {
  const key = '019b0000-0000-7000-9000-000000000001';
  const input = {
    targetType: 'event',
    targetId: '019b0000-0000-7000-8100-000000000001',
    reason: 'danger',
    evidenceAssetIds: [],
  };

  it.each([undefined, '', 'not-a-uuid'])('requires a valid Idempotency-Key (%s)', (invalidKey) => {
    const report = vi.fn();
    const controller = new SafetyController({ report } as never);

    expect(() => controller.report(user as never, invalidKey as never, input)).toThrow();
    expect(report).not.toHaveBeenCalled();
  });

  it('keeps the OpenAPI report category and safe replay envelopes aligned with runtime', async () => {
    const contract = await readFile(
      new URL('../../../../../packages/contracts/openapi.yaml', import.meta.url),
      'utf8',
    );
    const path = contract.slice(contract.indexOf('  /reports:'), contract.indexOf('  /appeals:'));
    const schema = contract.slice(contract.indexOf('    ReportInput:'), contract.indexOf('    SyncChange:'));
    const receipt = contract.slice(contract.indexOf('    ReportReceipt:'), contract.indexOf('    ReportInput:'));

    expect(receipt).toContain('additionalProperties: false');
    expect(schema).toContain('reason:');
    expect(schema).toContain('enum: [danger, personal_safety, fraud, harassment, harassment_or_hate, spam, minor_safety, other, unsafe]');
    expect(path).toContain("$ref: '#/components/parameters/IdempotencyKey'");
    for (const status of ['400', '403', '404', '409', '422']) {
      expect(path).toContain(`'${status}': { $ref: '#/components/responses/Error' }`);
    }
  });

  it('forwards the validated idempotency key and input', () => {
    const report = vi.fn();
    const controller = new SafetyController({ report } as never);

    void controller.report(user, key, input);

    expect(report).toHaveBeenCalledWith(user.id, key, input);
  });

  it('canonicalizes an uppercase UUID before forwarding it', () => {
    const report = vi.fn();
    const controller = new SafetyController({ report } as never);

    void controller.report(user, key.toUpperCase(), input);

    expect(report).toHaveBeenCalledWith(user.id, key, input);
  });

  it('returns the byte-equivalent committed replay envelope', async () => {
    const response = {
      reference: 'SPT-2026-0123456789AB',
      status: 'open',
      submittedAt: '2026-07-17T00:00:00.000Z',
    };
    const report = vi.fn().mockResolvedValue(response);
    const controller = new SafetyController({ report } as never);

    const first = await controller.report(user, key, input);
    const replay = await controller.report(user, key, input);

    expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
    expect(replay).toEqual(response);
  });
});
