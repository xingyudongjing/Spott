import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessTokenGuard } from './auth.guard.js';
import { FieldCrypto } from './crypto.js';
import { IdempotencyService } from './idempotency.js';
import { SessionAuthority } from './session-authority.js';
import { WebBFFAuthority, WebBFFTransportGuard } from './web-bff-authority.js';

@Global()
@Module({
  providers: [
    FieldCrypto,
    IdempotencyService,
    SessionAuthority,
    WebBFFAuthority,
    { provide: APP_GUARD, useClass: WebBFFTransportGuard },
    { provide: APP_GUARD, useClass: AccessTokenGuard },
  ],
  exports: [FieldCrypto, IdempotencyService, SessionAuthority, WebBFFAuthority],
})
export class PlatformModule {}
