import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../../../..');
const source = readFileSync(resolve(repositoryRoot, 'packages/contracts/openapi.yaml'), 'utf8');
const bundle = readFileSync(resolve(repositoryRoot, 'packages/contracts/openapi.bundle.yaml'), 'utf8');
const generated = readFileSync(resolve(repositoryRoot, 'packages/api-client/src/schema.d.ts'), 'utf8');

interface OpenAPIContract {
  readonly components: {
    readonly schemas: Record<string, unknown>;
  };
}

function revokeResultValidator(contract: string) {
  const parsed = load(contract) as OpenAPIContract;
  return new Ajv2020({ strict: false, validateFormats: false }).compile({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    components: { schemas: parsed.components.schemas },
    $ref: '#/components/schemas/WebSessionCompletionRevokeResult',
  });
}

describe('Atomic Web email completion contract', () => {
  it.each([
    ['source', source],
    ['bundle', bundle],
  ])('validates exact revoked and discarded response instances in the %s schema', (_label, contract) => {
    const validate = revokeResultValidator(contract);
    const revoked = {
      state: 'revoked',
      sessionId: '019b0000-0000-7000-8000-000000000001',
      bindingId: '019b0000-0000-7000-8000-000000000002',
      deviceId: '019b0000-0000-7000-8000-000000000003',
    };
    const discarded = {
      state: 'discarded',
      sessionId: '019b0000-0000-7000-8000-000000000001',
      bindingId: '019b0000-0000-7000-8000-000000000002',
      deviceId: '019b0000-0000-7000-8000-000000000003',
    };

    expect(validate(revoked), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(discarded), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...revoked, material: { refreshToken: 'must-not-validate' } })).toBe(false);
  });

  it('publishes IDs only until a strict BFF completion attempt is accepted or discarded', () => {
    const start = source.indexOf('\n  /auth/web/complete:');
    const end = source.indexOf('\n  /auth/apple:', start);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const operation = source.slice(start, end);
    expect(operation).toContain('operationId: completeWebEmailSession');
    expect(operation).toContain("$ref: '#/components/schemas/WebEmailSessionCompletionRequest'");
    expect(operation).toContain("$ref: '#/components/responses/WebSessionCompletionPending'");
    expect(operation).toContain('/auth/web/completion-attempts/{attemptId}/accept:');
    expect(operation).toContain('/auth/web/completion-attempts/{attemptId}/discard:');
    expect(operation).toContain('/auth/web/completion-attempts/{attemptId}/revoke:');
    expect(operation).toContain('operationId: acceptWebSessionCompletionAttempt');
    expect(operation).toContain('operationId: discardWebSessionCompletionAttempt');
    expect(operation).toContain('operationId: revokeWebSessionCompletionAttempt');
    expect(operation).toContain("$ref: '#/components/schemas/WebSessionCompletionDispositionRequest'");
    expect(operation.match(/WebSessionCompletionDispositionResult/gu)).toHaveLength(2);
    expect(operation).toContain("$ref: '#/components/responses/WebSessionCompletionRevokeResult'");
    expect(operation).toContain("'401':");
    expect(operation).toContain("'403':");
    expect(operation).toContain("'409':");

    for (const contract of [bundle, generated]) {
      expect(contract).toContain('/auth/web/complete');
      expect(contract).toContain('/auth/web/completion-attempts/{attemptId}/accept');
      expect(contract).toContain('/auth/web/completion-attempts/{attemptId}/discard');
      expect(contract).toContain('/auth/web/completion-attempts/{attemptId}/revoke');
      expect(contract).toContain('completeWebEmailSession');
      expect(contract).toContain('acceptWebSessionCompletionAttempt');
      expect(contract).toContain('discardWebSessionCompletionAttempt');
      expect(contract).toContain('revokeWebSessionCompletionAttempt');
      expect(contract).toContain('WebEmailSessionCompletionRequest');
      expect(contract).toContain('WebSessionCompletionPending');
      expect(contract).toContain('WebSessionCompletionDispositionRequest');
      expect(contract).toContain('WebSessionCompletionDispositionResult');
      expect(contract).toContain('WebSessionCompletionRevokeResult');
      expect(contract).toContain('WebSessionCompletionMaterial');
    }

    const pendingStart = source.indexOf('\n    WebSessionCompletionPending:');
    const pendingEnd = source.indexOf('\n    WebSessionCompletionDispositionRequest:', pendingStart);
    const pending = source.slice(pendingStart, pendingEnd);
    expect(pending).toContain('additionalProperties: false');
    expect(pending).toContain('required: [state, sessionId, bindingId, deviceId]');
    expect(pending).toContain('state: { type: string, const: pending }');
    expect(pending).not.toMatch(/(?:accessToken|refreshToken|refreshFamilyId)/u);

    const requestStart = pendingEnd;
    const requestEnd = source.indexOf('\n    WebSessionCompletionAccepted:', requestStart);
    const request = source.slice(requestStart, requestEnd);
    expect(request).toContain('additionalProperties: false');
    expect(request).toContain('required: [challengeId, deviceId, binding]');
    expect(request).toContain("binding: { $ref: '#/components/schemas/InitialPersistentDeviceBindingProof' }");

    const acceptedStart = requestEnd;
    const acceptedEnd = source.indexOf('\n    WebSessionCompletionDiscarded:', acceptedStart);
    const accepted = source.slice(acceptedStart, acceptedEnd);
    expect(accepted).toContain('required: [state, material]');
    expect(accepted).toContain('state: { type: string, const: accepted }');
    expect(accepted).toContain("material: { $ref: '#/components/schemas/WebSessionCompletionMaterial' }");

    const discardedStart = acceptedEnd;
    const discardedEnd = source.indexOf('\n    WebSessionCompletionDispositionResult:', discardedStart);
    const discarded = source.slice(discardedStart, discardedEnd);
    expect(discarded).toContain('required: [state, bindingId, deviceId]');
    expect(discarded).toContain('state: { type: string, const: discarded }');
    expect(discarded).toContain("sessionId: { $ref: '#/components/schemas/UUID' }");

    const revokedStart = source.indexOf('\n    WebSessionCompletionRevoked:', discardedEnd);
    const revokedEnd = source.indexOf('\n    WebSessionCompletionRevokeResult:', revokedStart);
    const revoked = source.slice(revokedStart, revokedEnd);
    expect(revokedStart).toBeGreaterThan(discardedEnd);
    expect(revoked).toContain('required: [state, sessionId, bindingId, deviceId]');
    expect(revoked).toContain('state: { type: string, const: revoked }');
    expect(revoked).not.toMatch(/(?:accessToken|refreshToken|material)/u);

    const revokeResultEnd = source.indexOf('\n    WebSessionCompletionMaterial:', revokedEnd);
    const revokeResult = source.slice(revokedEnd, revokeResultEnd);
    expect(revokeResult).toContain("$ref: '#/components/schemas/WebSessionCompletionRevoked'");
    expect(revokeResult).toContain("$ref: '#/components/schemas/WebSessionCompletionDiscarded'");
  });
});

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

describe('Auth verified Web logout contracts', () => {
  it('publishes strict current and all-session logout operations in every generated contract', () => {
    const start = source.indexOf('\n  /auth/logout:');
    const end = source.indexOf('\n  /auth/device-binding/upgrade:', start);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const operations = source.slice(start, end);
    expect(operations).toContain('operationId: logoutWebSession');
    expect(operations).toContain('operationId: logoutAllWebSessions');
    expect(operations.match(/WebBoundSessionMutationRequest/gu)).toHaveLength(2);
    expect(operations).toContain("'204': { description: Session revoked; response body is empty. }");
    expect(operations).toContain("'200':");
    expect(operations).toContain("$ref: '#/components/schemas/RevokedSessionCount'");
    expect(operations.match(/'401':/gu)).toHaveLength(2);
    expect(operations.match(/'403':/gu)).toHaveLength(2);

    const requestStart = source.indexOf('\n    WebBoundSessionMutationRequest:');
    const requestEnd = source.indexOf('\n    RevokedSessionCount:', requestStart);
    expect(requestStart).toBeGreaterThan(-1);
    expect(requestEnd).toBeGreaterThan(requestStart);
    const request = source.slice(requestStart, requestEnd);
    expect(request).toContain('additionalProperties: false');
    expect(request).toContain(
      'required: [refreshToken, deviceId, deviceBindingProof, refreshEnvelopeClaims]',
    );
    expect(request).toContain("deviceBindingProof: { $ref: '#/components/schemas/PersistentDeviceBindingProof' }");
    expect(request).toContain("refreshEnvelopeClaims: { $ref: '#/components/schemas/WebRefreshEnvelopeDBClaims' }");
    expect(request).not.toMatch(/\b(?:scope|userId)\s*:/u);

    const countStart = source.indexOf('\n    RevokedSessionCount:');
    const countEnd = source.indexOf('\n    WebRefreshEnvelopeDBClaims:', countStart);
    const count = source.slice(countStart, countEnd);
    expect(count).toContain('additionalProperties: false');
    expect(count).toContain('required: [revokedCount]');
    expect(count).toContain('revokedCount: { type: integer, minimum: 0 }');

    for (const contract of [bundle, generated]) {
      expect(contract).toContain('/auth/logout');
      expect(contract).toContain('/auth/logout-all');
      expect(contract).toContain('logoutWebSession');
      expect(contract).toContain('logoutAllWebSessions');
    }
  });
});
