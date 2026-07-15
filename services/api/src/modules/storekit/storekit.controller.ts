import { Body, Controller, Get, Headers, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Public, type AuthenticatedUser } from '../../platform/request-context.js';
import { StoreKitService } from './storekit.service.js';

@Controller()
export class StoreKitController {
  constructor(private readonly storeKit: StoreKitService) {}

  @Public()
  @Get('store/products')
  catalog() {
    return this.storeKit.catalog();
  }

  @Post('store/apple/transactions')
  verifyTransaction(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = z.object({ signedTransaction: z.string().min(100).max(100_000) }).parse(body);
    return this.storeKit.verifyAndCredit(user.id, input.signedTransaction, idempotencyKey);
  }

  @Public()
  @Post('webhooks/apple/storekit')
  @HttpCode(204)
  async notification(@Body() body: unknown): Promise<void> {
    const input = z.object({ signedPayload: z.string().min(100).max(250_000) }).parse(body);
    await this.storeKit.processNotification(input.signedPayload);
  }
}
