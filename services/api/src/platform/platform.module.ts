import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessTokenGuard } from './auth.guard.js';
import { FieldCrypto } from './crypto.js';
import { IdempotencyService } from './idempotency.js';

@Global()
@Module({
  providers: [
    FieldCrypto,
    IdempotencyService,
    { provide: APP_GUARD, useClass: AccessTokenGuard },
  ],
  exports: [FieldCrypto, IdempotencyService],
})
export class PlatformModule {}
