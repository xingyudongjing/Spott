import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import { DomainError } from '@spott/domain';
import {
  CurrentUser,
  Public,
  type AuthenticatedUser,
  type SpottRequest,
} from '../../platform/request-context.js';
import { parseDiscoveryQuery } from './events.discovery-query.js';
import { EventsService } from './events.service.js';
import { EventPromotionService } from './events.promotion.service.js';

export const draftSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  description: z.string().max(10_000).optional(),
  categoryId: z.string().max(80).optional(),
  startsAt: z.iso.datetime().optional(),
  endsAt: z.iso.datetime().optional(),
  deadlineAt: z.iso.datetime().optional(),
  regionId: z.string().max(80).optional(),
  publicArea: z.string().max(120).optional(),
  exactAddress: z.string().max(500).optional(),
  capacity: z.number().int().min(2).max(500).optional(),
  registrationMode: z.enum(['automatic', 'approval', 'invite_only']).optional(),
  waitlistEnabled: z.boolean().optional(),
  tags: z.array(z.string().min(1).max(40)).max(5).optional(),
  attendeeRequirements: z.string().max(2000).optional(),
  riskFlags: z.array(z.enum(['alcohol', 'late_night', 'family', 'minors', 'outdoor', 'mountain', 'water', 'high_fee', 'career', 'investment', 'gender_limited'])).max(8).optional(),
  riskDetails: z.record(z.string(), z.string().max(1000)).optional(),
  groupId: z.string().uuid().nullable().optional(),
  checkinMode: z.enum(['dynamic_qr', 'six_digit', 'manual']).optional(),
  commentPermission: z.enum(['disabled', 'participants', 'group_members']).optional(),
  posterEnabled: z.boolean().optional(),
  exactAddressVisibility: z.enum(['public', 'confirmed']).optional(),
  format: z.enum(['in_person', 'online', 'hybrid']).optional(),
  primaryLocale: z.enum(['zh-Hans', 'ja', 'en']).optional(),
  supportedLocales: z.array(z.enum(['zh-Hans', 'ja', 'en'])).min(1).max(3).optional(),
  coordinate: z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  }).optional(),
  registrationQuestions: z.array(z.object({
    id: z.string().uuid().optional(),
    prompt: z.string().min(1).max(240),
    kind: z.enum(['text', 'single_choice', 'boolean']).default('text'),
    required: z.boolean().default(false),
    options: z.array(z.string().min(1).max(120)).max(12).default([]),
  })).max(10).optional(),
  fee: z
    .object({
      isFree: z.boolean(),
      amountJPY: z.number().int().positive().optional(),
      collectorName: z.string().max(120).optional(),
      method: z.string().max(120).optional(),
      paymentDeadlineText: z.string().max(240).optional(),
      refundPolicy: z.string().max(2000).optional(),
    })
    .optional(),
}).superRefine((input, context) => {
  if ((input.primaryLocale === undefined) !== (input.supportedLocales === undefined)) {
    context.addIssue({
      code: 'custom',
      path: ['primaryLocale'],
      message: 'primaryLocale and supportedLocales must be provided together',
    });
  }
  if (
    input.primaryLocale !== undefined
    && input.supportedLocales !== undefined
    && (
      !input.supportedLocales.includes(input.primaryLocale)
      || new Set(input.supportedLocales).size !== input.supportedLocales.length
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['supportedLocales'],
      message: 'supportedLocales must be unique and contain primaryLocale',
    });
  }
});

@Controller()
export class EventsController {
  constructor(
    private readonly events: EventsService,
    private readonly promotions: EventPromotionService,
  ) {}

  @Public()
  @Get('discovery/feed')
  discovery(
    @Req() request: SpottRequest,
    @Query() query: Record<string, string | undefined>,
  ) {
    return this.events.discovery(request.user, parseDiscoveryQuery(query));
  }

  @Public()
  @Get('events/search')
  search(
    @Req() request: SpottRequest,
    @Query() query: Record<string, string | undefined>,
  ) {
    return this.events.discovery(request.user, parseDiscoveryQuery(query));
  }

  @Public()
  @Get('events/:id')
  get(@Req() request: SpottRequest, @Param('id') id: string) {
    return this.events.get(id, request.user);
  }

  @Public()
  @Get('events/:id/comments')
  comments(@Req() request: SpottRequest, @Param('id') id: string) {
    return this.events.comments(id, request.user?.id);
  }

  @Post('events/:id/comments')
  createComment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
  ) {
    const input = z.object({
      body: z.string().trim().min(1).max(2000),
      parentId: z.string().uuid().optional(),
      locale: z.enum(['zh-Hans', 'ja', 'en']).default('zh-Hans'),
    }).parse(body);
    return this.events.createComment(user, id, this.requiredKey(key), input);
  }

  @Get('me/hosted-events')
  hosted(@CurrentUser() user: AuthenticatedUser) {
    return this.events.hosted(user);
  }

  @Get('me/favorite-events')
  favorites(@CurrentUser() user: AuthenticatedUser) {
    return this.events.favorites(user);
  }

  @Post('events/drafts')
  createDraft(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
  ) {
    return this.events.createDraft(user, this.requiredKey(key), draftSchema.parse(body));
  }

  @Patch('events/:id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string,
    @Headers('if-match') ifMatch: string,
    @Body() body: unknown,
  ) {
    return this.events.update(
      user,
      id,
      this.requiredKey(key),
      this.version(ifMatch),
      draftSchema.parse(body),
    );
  }

  @Post('events/:id/submit')
  submit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string,
    @Headers('if-match') ifMatch: string,
    @Body() body: unknown,
  ) {
    const input = z.object({ quoteId: z.string().uuid() }).parse(body);
    return this.events.submit(user, id, this.requiredKey(key), this.version(ifMatch), input.quoteId);
  }

  @Post('events/:id/cancel')
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
  ) {
    const input = z.object({ reason: z.string().min(3).max(500) }).parse(body);
    return this.events.cancel(user, id, this.requiredKey(key), input.reason);
  }

  @Post('events/:id/promotions')
  @HttpCode(201)
  promote(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
  ) {
    const input = z
      .object({
        tier: z.enum(['boost_24h', 'boost_72h', 'boost_7d']),
        quoteId: z.string().uuid(),
      })
      .parse(body);
    return this.promotions.purchase(user, id, input.tier, input.quoteId, this.requiredKey(key));
  }

  @Public()
  @Get('events/:id/promotion')
  activePromotion(@Param('id') id: string) {
    return this.promotions.active(id);
  }

  @Put('events/:id/favorite')
  @HttpCode(204)
  async favorite(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<void> {
    await this.events.setFavorite(user.id, id, true);
  }

  @Delete('events/:id/favorite')
  @HttpCode(204)
  async unfavorite(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<void> {
    await this.events.setFavorite(user.id, id, false);
  }

  private requiredKey(key: string | undefined): string {
    if (!key || !z.string().uuid().safeParse(key).success) {
      throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', '请求缺少有效的幂等键。', 400);
    }
    return key;
  }

  private version(value: string | undefined): number {
    const match = value?.match(/^"([1-9][0-9]*)"$/);
    if (!match) throw new DomainError('VERSION_REQUIRED', '请求缺少有效的 If-Match 版本。', 400);
    return Number(match[1]);
  }
}
