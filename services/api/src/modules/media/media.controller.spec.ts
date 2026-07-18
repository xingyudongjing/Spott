import { describe, expect, it, vi } from 'vitest';
import { DomainError } from '@spott/domain';
import { readFile } from 'node:fs/promises';
import { IS_PUBLIC_KEY, type AuthenticatedUser } from '../../platform/request-context.js';
import { MediaController } from './media.controller.js';

const HTTP_CODE_METADATA = '__httpCode__';

interface ReplyStub {
  status: (code: number) => ReplyStub;
  header: (name: string, value: string) => ReplyStub;
}

interface MediaControllerContract {
  createIntent(
    user: AuthenticatedUser,
    key: string | undefined,
    body: unknown,
    reply: ReplyStub,
  ): Promise<unknown>;
  complete(
    user: AuthenticatedUser,
    assetId: string,
    key: string | undefined,
    hash: string | undefined,
  ): Promise<unknown>;
  legacyComplete(
    user: AuthenticatedUser,
    assetId: string,
    key: string | undefined,
    hash: string | undefined,
  ): Promise<unknown>;
  abandon(user: AuthenticatedUser, assetId: string, key: string | undefined): Promise<unknown>;
  attachEvent(
    user: AuthenticatedUser,
    assetId: string,
    eventId: string,
    key: string | undefined,
    body: unknown,
  ): Promise<unknown>;
  attachProfile(user: AuthenticatedUser, assetId: string, key: string | undefined): Promise<unknown>;
  attachGroup(
    user: AuthenticatedUser,
    assetId: string,
    groupId: string,
    key: string | undefined,
  ): Promise<unknown>;
  arrangeEvent(
    user: AuthenticatedUser,
    eventId: string,
    key: string | undefined,
    body: unknown,
  ): Promise<unknown>;
  recoverAttempt(
    user: AuthenticatedUser,
    attemptId: string,
    reply: ReplyStub,
  ): Promise<unknown>;
  uploadContent(
    attemptId: string,
    capability: string | undefined,
    mimeType: string | undefined,
    byteSize: string | undefined,
    hash: string | undefined,
    cookie: string | undefined,
    authorization: string | undefined,
    request: { raw: unknown },
  ): Promise<unknown>;
}

const user: AuthenticatedUser = {
  id: '019b0000-0000-7000-8000-000000000001',
  sessionId: 'session',
  phoneVerified: true,
  restrictions: [],
  roles: ['verified'],
};
const canonicalKey = '019b0000-0000-7000-9000-00000000000a';
const uploadBody = {
  purpose: 'event_cover',
  filename: 'poster.jpg',
  mimeType: 'image/jpeg',
  byteSize: 1_024,
  focalX: 0.5,
  focalY: 0.5,
  contentSha256: 'AB'.repeat(32),
};
const assetId = '019b0000-0000-7000-8100-000000000001';
const secondAssetId = '019b0000-0000-7000-8100-000000000002';
const eventId = '019b0000-0000-7000-8200-000000000001';
const groupId = '019b0000-0000-7000-8300-000000000001';
const contentHash = 'CD'.repeat(32);

function harness() {
  const media = {
    createIntent: vi.fn(),
    complete: vi.fn(),
    abandon: vi.fn(),
    attachEvent: vi.fn(),
    attachProfile: vi.fn(),
    attachGroup: vi.fn(),
    arrangeEvent: vi.fn(),
    recoverAttempt: vi.fn(),
    uploadContent: vi.fn(),
  };
  const controller = new MediaController(media as never) as unknown as MediaControllerContract;
  const reply: ReplyStub = {
    status: vi.fn(function status(this: ReplyStub) { return this; }),
    header: vi.fn(function header(this: ReplyStub) { return this; }),
  };
  return { controller, media, reply };
}

describe('MediaController upload-intent contract', () => {
  it.each([undefined, '', 'not-a-uuid'])('rejects an invalid Idempotency-Key (%s)', async (invalidKey) => {
    const { controller, media, reply } = harness();

    await expect(controller.createIntent(user, invalidKey, uploadBody, reply)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      status: 400,
    });
    expect(media.createIntent).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', { ...uploadBody, contentSha256: undefined }],
    ['malformed', { ...uploadBody, contentSha256: 'not-a-digest' }],
    ['non-64-character', { ...uploadBody, contentSha256: 'ab'.repeat(31) }],
  ])('rejects a %s contentSha256 before service invocation', async (_label, body) => {
    const { controller, media, reply } = harness();

    await expect(controller.createIntent(user, canonicalKey, body, reply)).rejects.toBeTruthy();
    expect(media.createIntent).not.toHaveBeenCalled();
  });

  it.each([
    [201, false],
    [200, true],
  ] as const)('uses runtime status %i and returns only the public response (replay=%s)', async (status, replay) => {
    const { controller, media, reply } = harness();
    const response = {
      attemptId: canonicalKey,
      assetId: '019b0000-0000-7000-8100-000000000001',
      state: replay ? 'in_progress' : 'pending_upload',
    };
    media.createIntent.mockResolvedValue({ status, body: response });

    await expect(controller.createIntent(
      user,
      canonicalKey.toUpperCase(),
      uploadBody,
      reply,
    )).resolves.toEqual(response);

    expect(media.createIntent).toHaveBeenCalledWith(user, {
      ...uploadBody,
      contentSha256: uploadBody.contentSha256.toLowerCase(),
    }, canonicalKey);
    expect(reply.status).toHaveBeenCalledWith(status);
    expect(reply.header).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(reply.header).toHaveBeenCalledWith('Pragma', 'no-cache');
    expect(reply.header).toHaveBeenCalledWith('Referrer-Policy', 'no-referrer');
  });

  it('preserves the existing service input position while appending the canonical key', async () => {
    const { controller, media, reply } = harness();
    const response = { assetId, state: 'pending_upload' };
    media.createIntent.mockImplementation(async (_actor, input) => {
      expect(input).toMatchObject({ purpose: 'event_cover', contentSha256: 'ab'.repeat(32) });
      return response;
    });

    await expect(controller.createIntent(user, canonicalKey, uploadBody, reply)).resolves.toEqual(response);

    expect(media.createIntent).toHaveBeenCalledWith(
      user,
      { ...uploadBody, contentSha256: 'ab'.repeat(32) },
      canonicalKey,
    );
  });
});

describe('MediaController upload recovery boundary', () => {
  it.each(['', 'not-a-uuid'])('rejects an invalid attempt path (%s)', async (attemptId) => {
    const { controller, media, reply } = harness();

    await expect(controller.recoverAttempt(user, attemptId, reply)).rejects.toBeTruthy();
    expect(media.recoverAttempt).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'credential-bearing pending recovery',
      response: {
        attemptId: canonicalKey,
        assetId,
        state: 'pending_upload',
        uploadUrl: `https://api.spott.test/v1/media/upload-attempts/${canonicalKey}/content`,
        capability: 'opaque-capability',
      },
    },
    {
      label: 'state-only committed recovery',
      response: { attemptId: canonicalKey, assetId, state: 'committed', receipt: { assetId } },
    },
  ])('returns $label without adding or removing fields', async ({ response }) => {
    const { controller, media, reply } = harness();
    media.recoverAttempt.mockResolvedValue(response);

    await expect(controller.recoverAttempt(user, canonicalKey.toUpperCase(), reply))
      .resolves.toEqual(response);

    expect(media.recoverAttempt).toHaveBeenCalledWith(user, canonicalKey);
    expect(reply.header).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(reply.header).toHaveBeenCalledWith('Pragma', 'no-cache');
    expect(reply.header).toHaveBeenCalledWith('Referrer-Policy', 'no-referrer');
  });
});

describe('MediaController gateway route boundary', () => {
  const capability = `spott_${'a'.repeat(64)}`;
  const request = { raw: { readable: true } };

  it('uses the capability as the only route authentication authority', () => {
    const prototype = MediaController.prototype as unknown as Record<string, unknown>;
    const handler = prototype['uploadContent'];
    expect(typeof handler).toBe('function');
    if (typeof handler !== 'function') throw new Error('uploadContent handler is missing');
    expect(Reflect.getMetadata(
      IS_PUBLIC_KEY,
      handler,
    )).toBe(true);
  });

  const upload = (
    controller: MediaControllerContract,
    overrides: Partial<{
      attemptId: string;
      capability: string;
      mimeType: string;
      byteSize: string;
      hash: string;
      cookie: string;
      authorization: string;
    }> = {},
  ) => controller.uploadContent(
    overrides.attemptId ?? canonicalKey,
    Object.hasOwn(overrides, 'capability') ? overrides.capability : capability,
    overrides.mimeType ?? 'image/jpeg',
    overrides.byteSize ?? '1024',
    overrides.hash ?? contentHash,
    overrides.cookie,
    overrides.authorization,
    request,
  );

  it.each([
    ['missing capability', { capability: '' }],
    ['unsupported MIME', { mimeType: 'image/svg+xml' }],
    ['missing length', { byteSize: '' }],
    ['non-numeric length', { byteSize: '1kb' }],
    ['zero length', { byteSize: '0' }],
    ['over-limit length', { byteSize: String(20 * 1024 * 1024 + 1) }],
    ['invalid hash', { hash: 'not-a-hash' }],
  ] as const)('rejects %s before invoking the gateway service', async (_label, overrides) => {
    const { controller, media } = harness();

    await expect(Promise.resolve().then(() => upload(controller, overrides))).rejects.toBeTruthy();
    expect(media.uploadContent).not.toHaveBeenCalled();
  });

  it.each([
    ['Cookie', { cookie: 'session=forbidden' }],
    ['Authorization', { authorization: 'Bearer forbidden' }],
  ] as const)('rejects ambient %s credentials', async (_label, overrides) => {
    const { controller, media } = harness();

    await expect(Promise.resolve().then(() => upload(controller, overrides))).rejects.toMatchObject({
      code: 'MEDIA_GATEWAY_AMBIENT_CREDENTIALS_FORBIDDEN',
      status: 400,
    });
    expect(media.uploadContent).not.toHaveBeenCalled();
  });

  it.each([
    ['forged capability', 'MEDIA_GATEWAY_CAPABILITY_INVALID', 403],
    ['expired capability', 'MEDIA_GATEWAY_CAPABILITY_EXPIRED', 403],
    ['wrong attempt path', 'MEDIA_GATEWAY_CAPABILITY_INVALID', 403],
    ['elapsed request deadline', 'MEDIA_GATEWAY_DEADLINE_EXCEEDED', 408],
  ] as const)('propagates safe %s rejection', async (_label, code, status) => {
    const { controller, media } = harness();
    media.uploadContent.mockRejectedValue(new DomainError(code, '上传请求无法继续。', status));

    await expect(upload(controller, _label === 'wrong attempt path'
      ? { attemptId: '019b0000-0000-7000-9000-00000000000b' }
      : {})).rejects.toMatchObject({ code, status });
  });

  it('captures the monotonic handler-entry instant and forwards normalized exact headers', async () => {
    const { controller, media } = harness();
    const now = vi.spyOn(performance, 'now').mockReturnValue(42.25);
    const response = { attemptId: canonicalKey, assetId, state: 'committed' };
    media.uploadContent.mockResolvedValue(response);

    await expect(upload(controller, {
      attemptId: canonicalKey.toUpperCase(),
      hash: contentHash.toUpperCase(),
    })).resolves.toEqual(response);

    expect(media.uploadContent).toHaveBeenCalledWith({
      attemptId: canonicalKey,
      capability,
      mimeType: 'image/jpeg',
      byteSize: 1_024,
      contentSha256: contentHash.toLowerCase(),
      handlerStartedAt: 42.25,
      stream: request.raw,
    });
    now.mockRestore();
  });
});

describe('MediaController mutation idempotency boundary', () => {
  const mutationCases = [
    ['complete', (controller: MediaControllerContract, key: string | undefined) => controller.complete(user, assetId, key, contentHash)],
    ['abandon', (controller: MediaControllerContract, key: string | undefined) => controller.abandon(user, assetId, key)],
    ['attach event', (controller: MediaControllerContract, key: string | undefined) => controller.attachEvent(user, assetId, eventId, key, { kind: 'cover', sortOrder: 0 })],
    ['attach profile', (controller: MediaControllerContract, key: string | undefined) => controller.attachProfile(user, assetId, key)],
    ['attach group', (controller: MediaControllerContract, key: string | undefined) => controller.attachGroup(user, assetId, groupId, key)],
    ['arrange event', (controller: MediaControllerContract, key: string | undefined) => controller.arrangeEvent(user, eventId, key, { orderedAssetIds: [assetId, secondAssetId] })],
  ] as const;

  it.each(['complete', 'attachEvent', 'arrangeEvent'] as const)(
    'returns runtime HTTP 200 for %s as documented',
    (method) => {
      const prototype = MediaController.prototype as unknown as Record<string, unknown>;
      const handler = prototype[method];
      expect(typeof handler).toBe('function');
      if (typeof handler !== 'function') throw new Error(`${method} handler is missing`);
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
    },
  );

  it.each(mutationCases)('requires a valid distinct key for %s', async (_label, invoke) => {
    for (const invalidKey of [undefined, '', 'not-a-uuid']) {
      const { controller } = harness();
      await expect(Promise.resolve().then(() => invoke(controller, invalidKey))).rejects.toMatchObject({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        status: 400,
      });
    }
  });

  it.each([undefined, '', 'not-a-digest', 'ab'.repeat(31), 'gg'.repeat(32)])(
    'rejects invalid completion SHA-256 (%s)',
    async (invalidHash) => {
      const { controller, media } = harness();

      await expect(Promise.resolve().then(() => controller.complete(
        user,
        assetId,
        canonicalKey,
        invalidHash,
      ))).rejects.toBeTruthy();
      expect(media.complete).not.toHaveBeenCalled();
    },
  );

  it('keeps the released completion route as an exact compatibility alias', async () => {
    const { controller, media } = harness();
    media.complete.mockResolvedValue({ assetId, state: 'processing' });

    await expect(controller.legacyComplete(
      user,
      assetId,
      canonicalKey.toUpperCase(),
      contentHash.toUpperCase(),
    )).resolves.toEqual({ assetId, state: 'processing' });

    expect(media.complete).toHaveBeenCalledWith(
      user,
      assetId,
      contentHash.toLowerCase(),
      canonicalKey,
    );
  });

  it('normalizes and forwards separate caller-retained mutation keys', async () => {
    const { controller, media } = harness();
    const keys = Array.from({ length: 6 }, (_, index) =>
      `019b0000-0000-7000-9000-${(index + 11).toString().padStart(12, '0')}`);
    Object.values(media).forEach((mock) => mock.mockResolvedValue({ ok: true }));

    await controller.complete(user, assetId, keys[0]!.toUpperCase(), contentHash);
    await controller.abandon(user, assetId, keys[1]);
    await controller.attachEvent(user, assetId, eventId, keys[2], { kind: 'gallery', sortOrder: 2 });
    await controller.attachProfile(user, assetId, keys[3]);
    await controller.attachGroup(user, assetId, groupId, keys[4]);
    await controller.arrangeEvent(user, eventId, keys[5], { orderedAssetIds: [secondAssetId, assetId] });

    expect(new Set(keys).size).toBe(keys.length);
    expect(media.complete).toHaveBeenCalledWith(user, assetId, contentHash.toLowerCase(), keys[0]);
    expect(media.abandon).toHaveBeenCalledWith(user, assetId, keys[1]);
    expect(media.attachEvent).toHaveBeenCalledWith(
      user,
      assetId,
      eventId,
      { kind: 'gallery', sortOrder: 2 },
      keys[2],
    );
    expect(media.attachProfile).toHaveBeenCalledWith(user, assetId, keys[3]);
    expect(media.attachGroup).toHaveBeenCalledWith(user, assetId, groupId, keys[4]);
    expect(media.arrangeEvent).toHaveBeenCalledWith(
      user,
      eventId,
      { orderedAssetIds: [secondAssetId, assetId] },
      keys[5],
    );
  });

  it.each(['attachEvent', 'attachProfile', 'attachGroup', 'arrangeEvent'] as const)(
    'returns the byte-equivalent committed %s replay envelope',
    async (method) => {
      const { controller, media } = harness();
      const response = { assetId, eventId, version: 7, orderedAssetIds: [assetId, secondAssetId] };
      media[method].mockResolvedValue(response);
      const key = '019b0000-0000-7000-9000-000000000099';
      const invoke = {
        attachEvent: () => controller.attachEvent(user, assetId, eventId, key, { kind: 'cover' }),
        attachProfile: () => controller.attachProfile(user, assetId, key),
        attachGroup: () => controller.attachGroup(user, assetId, groupId, key),
        arrangeEvent: () => controller.arrangeEvent(user, eventId, key, { orderedAssetIds: [assetId, secondAssetId] }),
      }[method];

      const first = await invoke();
      const replay = await invoke();

      expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
      expect(replay).toEqual(response);
    },
  );
});

describe('Task 22 media OpenAPI boundary', () => {
  async function contract() {
    return readFile(
      new URL('../../../../../packages/contracts/openapi.yaml', import.meta.url),
      'utf8',
    );
  }

  it('documents an unambiguous canonical completion path while retaining the legacy runtime alias', async () => {
    const source = await contract();
    const controllerSource = await readFile(new URL('./media.controller.ts', import.meta.url), 'utf8');

    expect(source).toContain('  /media/assets/{id}/complete:');
    expect(source).not.toContain('  /media/{id}/complete:');
    expect(controllerSource).toContain("@Post('assets/:id/complete')");
    expect(controllerSource).toContain("@Post(':id/complete')");
  });

  it('documents recoverable intent creation with named credential and state-only responses', async () => {
    const source = await contract();
    const paths = source.slice(source.indexOf('  /media/upload-intents:'), source.indexOf('  /shares:'));
    const schemas = source.slice(source.indexOf('    MediaUploadInput:'), source.indexOf('    ShareInput:'));

    expect(source).not.toContain('媒体上传意图/完成当前不承诺响应丢失恢复');
    expect(paths).toContain("$ref: '#/components/parameters/IdempotencyKey'");
    expect(paths).toContain("schema: { $ref: '#/components/schemas/MediaUploadCapabilityResponse' }");
    expect(paths).toContain("schema: { $ref: '#/components/schemas/MediaUploadReplayResponse' }");
    expect(paths).toContain('operationId: recoverMediaUploadAttempt');
    expect(paths).toContain('operationId: uploadMediaAttemptContent');
    expect(schemas).toContain('required: [purpose, filename, mimeType, byteSize, contentSha256]');
    expect(schemas).toContain("contentSha256: { $ref: '#/components/schemas/SHA256Input' }");
    expect(source).toContain("pattern: '^[A-Fa-f0-9]{64}$'");
    expect(schemas).toContain('MediaUploadCapabilityResponse:');
    expect(schemas).toContain('MediaUploadStateResponse:');
    expect(schemas).toContain('MediaUploadReplayResponse:');
  });

  it('separates pending credentials from strict uncommitted and committed state responses', async () => {
    const source = await contract();
    const credential = source.slice(
      source.indexOf('    MediaUploadCapabilityResponse:'),
      source.indexOf('    MediaUploadUncommittedStateResponse:'),
    );
    const uncommitted = source.slice(
      source.indexOf('    MediaUploadUncommittedStateResponse:'),
      source.indexOf('    MediaUploadCommittedStateResponse:'),
    );
    const committed = source.slice(
      source.indexOf('    MediaUploadCommittedStateResponse:'),
      source.indexOf('    MediaUploadStateResponse:'),
    );
    const stateOnly = source.slice(
      source.indexOf('    MediaUploadStateResponse:'),
      source.indexOf('    MediaUploadReplayResponse:'),
    );
    const gateway = source.slice(
      source.indexOf('    MediaGatewayUploadResponse:'),
      source.indexOf('    MediaCompletionResponse:'),
    );
    const receipt = source.slice(
      source.indexOf('    MediaCommittedUploadReceipt:'),
      source.indexOf('    MediaUploadCapabilityResponse:'),
    );

    expect(credential).toContain('uploadUrl:');
    expect(credential).toContain('capability:');
    expect(credential).toContain('requiredHeaders:');
    expect(credential).toContain('state: { type: string, const: pending_upload }');
    expect(uncommitted).toContain('additionalProperties: false');
    expect(uncommitted).not.toContain('receipt:');
    expect(committed).toContain('required: [attemptId, assetId, state, leaseState, receipt]');
    expect(committed).toContain("receipt: { $ref: '#/components/schemas/MediaCommittedUploadReceipt' }");
    expect(stateOnly).toContain("$ref: '#/components/schemas/MediaUploadUncommittedStateResponse'");
    expect(stateOnly).toContain("$ref: '#/components/schemas/MediaUploadCommittedStateResponse'");
    expect(gateway).toContain("$ref: '#/components/schemas/MediaGatewayInProgressResponse'");
    expect(gateway).toContain("$ref: '#/components/schemas/MediaUploadCommittedStateResponse'");
    for (const stateSchema of [uncommitted, committed, stateOnly, gateway]) {
      expect(stateSchema).not.toContain('uploadUrl:');
      expect(stateSchema).not.toContain('capability:');
      expect(stateSchema).not.toContain('requiredHeaders:');
    }
    expect(receipt).toContain('additionalProperties: false');
    expect(receipt).not.toContain('objectKey:');
    expect(receipt).not.toContain('capability:');
    expect(receipt).not.toContain('contentSha256:');
  });

  it('documents every mutation key, gateway binding header, and safe error envelope', async () => {
    const source = await contract();
    const paths = source.slice(source.indexOf('  /media/upload-intents:'), source.indexOf('  /shares:'));

    for (const operationId of [
      'createMediaUploadIntent',
      'completeMediaUpload',
      'abandonMediaAsset',
      'attachEventMedia',
      'attachProfileAvatar',
      'attachGroupCover',
      'arrangeEventMedia',
    ]) {
      const start = paths.indexOf(`operationId: ${operationId}`);
      expect(start).toBeGreaterThanOrEqual(0);
      const operation = paths.slice(start, paths.indexOf('\n  /', start + 1) === -1
        ? paths.length
        : paths.indexOf('\n  /', start + 1));
      expect(operation).toContain("$ref: '#/components/parameters/IdempotencyKey'");
    }

    const gateway = paths.slice(
      paths.indexOf('operationId: uploadMediaAttemptContent'),
      paths.indexOf('\n  /media/assets/{id}/complete:'),
    );
    expect(gateway).toContain('security: []');
    expect(gateway).toContain('name: X-Spott-Upload-Capability');
    expect(gateway).toContain('name: Content-Length');
    expect(gateway).toContain('name: X-Content-SHA256');
    expect(gateway).toContain("$ref: '#/components/schemas/MediaGatewayUploadResponse'");

    for (const status of ['403', '404', '409', '422']) {
      expect(paths).toContain(`'${status}': { $ref: '#/components/responses/Error' }`);
    }
  });
});
