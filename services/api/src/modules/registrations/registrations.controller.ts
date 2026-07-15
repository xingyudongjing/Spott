import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { DomainError } from '@spott/domain';
import { z } from 'zod';
import { CurrentUser, type AuthenticatedUser } from '../../platform/request-context.js';
import { RegistrationsService } from './registrations.service.js';

@Controller()
export class RegistrationsController {
  constructor(private readonly registrations: RegistrationsService) {}

  @Post('events/:id/registrations')
  register(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') eventId: string,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
  ) {
    const input = z
      .object({
        partySize: z.number().int().min(1).max(10),
        quoteId: z.string().uuid(),
        joinWaitlistIfFull: z.boolean().default(false),
        answers: z.record(z.string().uuid(), z.unknown()).default({}),
        attendeeNote: z.string().trim().max(1000).optional(),
      })
      .parse(body);
    return this.registrations.register(user, eventId, this.key(key), input);
  }

  @Get('events/:id/attendees')
  attendees(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') eventId: string,
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedStatus = status
      ? z.enum(['pending', 'confirmed', 'waitlisted', 'offered', 'checked_in', 'cancelled', 'rejected', 'no_show']).parse(status)
      : undefined;
    return this.registrations.attendees(user, eventId, parsedStatus, cursor, limit ? Number(limit) : 50);
  }

  @Post('registrations/:id/decision')
  decide(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
  ) {
    const input = z.object({
      decision: z.enum(['approve', 'reject']),
      reason: z.string().trim().min(2).max(500).optional(),
    }).parse(body);
    return this.registrations.decide(user, id, this.key(key), input);
  }

  @Post('registrations/:id/waitlist-acceptance')
  acceptWaitlist(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string,
  ) {
    return this.registrations.acceptWaitlist(user, id, this.key(key));
  }

  @Post('registrations/:id/cancel')
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string,
  ) {
    return this.registrations.cancel(user, id, this.key(key));
  }

  @Get('me/registrations')
  mine(
    @CurrentUser() user: AuthenticatedUser,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.registrations.mine(user.id, cursor, limit ? Number(limit) : 20);
  }

  @Post('events/:id/checkin-codes')
  createCode(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') eventId: string,
    @Body() body: unknown,
  ) {
    const input = z.object({ mode: z.enum(['dynamic_qr', 'six_digit']).optional() }).default({}).parse(body ?? {});
    return this.registrations.createCheckinCode(user, eventId, input.mode);
  }

  @Post('checkins')
  checkIn(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
  ) {
    const input = z
      .object({
        registrationId: z.string().uuid(),
        token: z.string().optional(),
        code: z.string().regex(/^[0-9]{6}$/).optional(),
        operationId: z.string().uuid(),
        deviceRecordedAt: z.iso.datetime().optional(),
      })
      .refine((value) => Boolean(value.token) !== Boolean(value.code), {
        message: 'token 和 code 必须且只能提供一个。',
      })
      .parse(body);
    return this.registrations.checkIn(user, this.key(key), input);
  }

  @Post('events/:id/checkins/manual')
  manualCheckIn(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') eventId: string,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
  ) {
    const input = z.object({
      registrationId: z.string().uuid(),
      operationId: z.string().uuid(),
      deviceRecordedAt: z.iso.datetime().optional(),
    }).parse(body);
    return this.registrations.manualCheckIn(user, eventId, this.key(key), input);
  }

  @Post('registrations/:id/checkin-corrections')
  correction(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = z.object({ reason: z.string().trim().min(3).max(1000) }).parse(body);
    return this.registrations.requestCorrection(user, id, input.reason);
  }

  @Get('events/:id/checkin-corrections')
  corrections(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') eventId: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedStatus = status
      ? z.enum(['pending', 'approved', 'rejected']).parse(status)
      : undefined;
    return this.registrations.corrections(user, eventId, parsedStatus, limit ? Number(limit) : 50);
  }

  @Post('checkin-corrections/:id/decision')
  decideCorrection(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = z.object({
      decision: z.enum(['approve', 'reject']),
      reason: z.string().trim().min(2).max(500).optional(),
    }).parse(body);
    return this.registrations.decideCorrection(user, id, input);
  }

  private key(value: string | undefined): string {
    if (!value || !z.string().uuid().safeParse(value).success) {
      throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', '请求缺少有效的幂等键。', 400);
    }
    return value;
  }
}
