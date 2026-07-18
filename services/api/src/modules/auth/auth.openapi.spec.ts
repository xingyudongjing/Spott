import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../../../..');
const source = readFileSync(resolve(repositoryRoot, 'packages/contracts/openapi.yaml'), 'utf8');
const bundle = readFileSync(resolve(repositoryRoot, 'packages/contracts/openapi.bundle.yaml'), 'utf8');
const generated = readFileSync(resolve(repositoryRoot, 'packages/api-client/src/schema.d.ts'), 'utf8');

describe('Auth device-binding upgrade contract', () => {
  it('publishes the strict BFF-only first-binding operation in every generated contract', () => {
    const start = source.indexOf('\n  /auth/device-binding/upgrade:');
    const end = source.indexOf('\n  /sessions/{id}:', start);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const operation = source.slice(start, end);
    expect(operation).toContain('operationId: upgradeDeviceBinding');
    expect(operation).toContain('required: [refreshToken, deviceId, attemptId, newBinding]');
    expect(operation).toContain("$ref: '#/components/schemas/InitialPersistentDeviceBindingProof'");
    expect(operation).toContain("$ref: '#/components/responses/DeviceBindingUpgradeMaterial'");
    expect(operation).toContain('additionalProperties: false');

    expect(bundle).toContain('/auth/device-binding/upgrade:');
    expect(bundle).toContain('operationId: upgradeDeviceBinding');
    expect(generated).toContain('"/auth/device-binding/upgrade"');
    expect(generated).toContain('upgradeDeviceBinding:');
  });
});
