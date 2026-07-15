import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import { DomainError } from '@spott/domain';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { CurrentUser, Public, type AuthenticatedUser, type SpottRequest } from '../../platform/request-context.js';
import { AuthService, type SessionResponse } from '../auth/auth.service.js';
import { OpsService } from './ops.service.js';

@Controller('ops')
export class OpsController {
  constructor(private readonly ops: OpsService, private readonly auth: AuthService) {}

  @Public()
  @Post('auth/email/verify')
  @HttpCode(200)
  async verifyOpsEmail(
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
  ) {
    const input = z.object({
      challengeId: z.string().uuid(),
      code: z.string().regex(/^[0-9]{6}$/),
      deviceId: z.string().uuid(),
    }).parse(body);
    const session = await this.auth.verifyEmailChallenge(input, 'ops');
    this.setSessionCookies(reply, session);
    return this.opsSessionResponse(session);
  }

  @Public()
  @Post('auth/refresh')
  @HttpCode(200)
  async refreshOpsSession(
    @Req() request: SpottRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const refreshToken = this.cookie(request.headers.cookie, '__Host-spott_ops_refresh');
    if (!refreshToken) throw new DomainError('TOKEN_INVALID', '运营刷新会话不存在。', 401);
    const session = await this.auth.refreshOps(refreshToken);
    this.setSessionCookies(reply, session);
    return this.opsSessionResponse(session);
  }

  @Delete('auth/session')
  @HttpCode(204)
  async revokeOpsSession(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.auth.revokeSession(user.id, user.sessionId);
    reply.header('Set-Cookie', [
      '__Host-spott_ops=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
      '__Host-spott_ops_refresh=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
    ]);
  }

  @Get('overview')
  overview(@CurrentUser() user: AuthenticatedUser) {
    return this.ops.overview(user);
  }

  @Get('users')
  users(
    @CurrentUser() user: AuthenticatedUser,
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('restriction') restriction?: string,
    @Query('deviceRisk') deviceRisk?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.ops.users(user, { q, status, restriction, deviceRisk }, cursor, this.limit(limit));
  }

  @Post('users/:id/restriction-decisions')
  @HttpCode(200)
  restrictionDecision(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: SpottRequest,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
  ) {
    const input = z.object({
      status: z.enum(['active', 'restricted', 'suspended']).optional(),
      restrictions: z.array(z.enum(['loginBlocked', 'publishBlocked', 'registerBlocked', 'pointsBlocked', 'commentBlocked'])).max(5),
      expiresAt: z.string().datetime().optional(),
      reason: z.string().min(3).max(2000),
    }).parse(body);
    return this.ops.restrictionDecision(user, id, this.version(ifMatch), this.idempotencyKey(key), input, request.requestId);
  }

  @Get('organizers')
  organizers(
    @CurrentUser() user: AuthenticatedUser,
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.ops.organizers(user, { q, status }, cursor, this.limit(limit));
  }

  @Get('events')
  events(
    @CurrentUser() user: AuthenticatedUser,
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('riskMin') riskMin?: string,
    @Query('region') region?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.ops.events(user, {
      q,
      status,
      region,
      riskMin: riskMin === undefined ? undefined : z.coerce.number().min(0).max(100).parse(riskMin),
    }, cursor, this.limit(limit));
  }

  @Post('events/:id/review')
  @HttpCode(200)
  reviewEvent(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: SpottRequest,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
  ) {
    const input = z.object({
      decision: z.enum(['published', 'needs_changes', 'rejected']),
      reason: z.string().min(3).max(2000),
    }).parse(body);
    return this.ops.reviewEvent(
      user,
      id,
      this.version(ifMatch),
      this.idempotencyKey(key),
      input.decision,
      input.reason,
      request.requestId,
    );
  }

  @Get('groups')
  groups(
    @CurrentUser() user: AuthenticatedUser,
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.ops.groups(user, { q, status }, cursor, this.limit(limit));
  }

  @Post('groups/:id/lifecycle-decision')
  @HttpCode(200)
  groupLifecycleDecision(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: SpottRequest,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
  ) {
    const input = z.object({
      decision: z.enum(['restore', 'start_closing', 'cancel_closing', 'remove']),
      reason: z.string().min(3).max(2000),
    }).parse(body);
    return this.ops.groupLifecycleDecision(user, id, this.version(ifMatch), this.idempotencyKey(key), input, request.requestId);
  }

  @Get('moderation/cases')
  cases(
    @CurrentUser() user: AuthenticatedUser,
    @Query('severity') severity?: string,
    @Query('status') status?: string,
    @Query('assignee') assignee?: string,
    @Query('targetType') targetType?: string,
    @Query('q') q?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.ops.cases(user, { severity, status, assignee, targetType, q }, cursor, this.limit(limit));
  }

  @Get('moderation/cases/:id')
  moderationCase(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('purpose') purpose?: string,
  ) {
    return this.ops.moderationCase(user, id, purpose);
  }

  @Post('moderation/cases/:id/claim')
  @HttpCode(200)
  claim(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: SpottRequest,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string,
    @Headers('idempotency-key') key: string,
  ) {
    return this.ops.claimCase(user, id, this.version(ifMatch), this.idempotencyKey(key), request.requestId);
  }

  @Post('moderation/cases/:id/decision')
  @HttpCode(200)
  decide(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: SpottRequest,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
  ) {
    const input = z.object({
      decision: z.enum(['no_action', 'hide', 'remove', 'restrict']),
      reason: z.string().min(3).max(2000),
      durationHours: z.number().int().positive().max(8760).optional(),
    }).parse(body);
    return this.ops.decide(user, id, this.version(ifMatch), this.idempotencyKey(key), input, request.requestId);
  }

  @Get('points/adjustments')
  pointAdjustments(
    @CurrentUser() user: AuthenticatedUser,
    @Query('state') state?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.ops.pointAdjustments(user, state, cursor, this.limit(limit));
  }

  @Post('points/adjustments')
  createPointAdjustment(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: SpottRequest,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
  ) {
    const input = z.object({
      targetUserId: z.string().uuid(),
      bucket: z.enum(['paid', 'free']),
      amount: z.number().int().min(-1_000_000).max(1_000_000).refine((value) => value !== 0),
      reason: z.string().min(3).max(2000),
      evidenceRef: z.string().max(500).optional(),
    }).parse(body);
    return this.ops.createPointAdjustment(user, this.idempotencyKey(key), input, request.requestId);
  }

  @Post('points/adjustments/:id/decision')
  @HttpCode(200)
  decidePointAdjustment(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: SpottRequest,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
  ) {
    const input = z.object({
      decision: z.enum(['approve', 'reject']),
      reason: z.string().min(3).max(2000),
    }).parse(body);
    return this.ops.decidePointAdjustment(user, id, this.idempotencyKey(key), input, request.requestId);
  }

  @Post('points/adjustments/:id/execute')
  @HttpCode(200)
  executePointAdjustment(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: SpottRequest,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string,
  ) {
    return this.ops.executePointAdjustment(user, id, this.idempotencyKey(key), request.requestId);
  }

  @Get('points/ledger-health')
  ledgerHealth(@CurrentUser() user: AuthenticatedUser) {
    return this.ops.ledgerHealth(user);
  }

  @Get('config-revisions')
  configRevisions(
    @CurrentUser() user: AuthenticatedUser,
    @Query('state') state?: string,
    @Query('key') key?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.ops.configRevisions(user, { status: state, key }, cursor, this.limit(limit));
  }

  @Post('config-revisions')
  createConfigRevision(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: SpottRequest,
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() body: unknown,
  ) {
    const input = z.object({
      key: z.string().min(3).max(200),
      value: z.unknown(),
      audience: z.record(z.string(), z.unknown()).default({}),
      region: z.string().max(100).optional(),
      minAppVersion: z.string().max(50).optional(),
      effectiveFrom: z.string().datetime().optional(),
      effectiveTo: z.string().datetime().optional(),
      reason: z.string().min(3).max(2000),
    }).parse(body);
    const { key, ...revision } = input;
    return this.ops.createConfigRevision(user, key, revision, this.idempotencyKey(idempotencyKey), request.requestId);
  }

  @Post('config-revisions/:id/impact-preview')
  @HttpCode(200)
  configImpact(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.ops.configImpact(user, id);
  }

  @Post('config-revisions/:id/approve')
  @HttpCode(200)
  approve(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: SpottRequest,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string,
    @Headers('idempotency-key') key: string,
  ) {
    return this.ops.approveConfig(user, id, this.version(ifMatch), this.idempotencyKey(key), request.requestId);
  }

  @Post('config-revisions/:id/activate')
  @HttpCode(200)
  activateConfig(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: SpottRequest,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string,
  ) {
    return this.ops.activateConfig(user, id, this.idempotencyKey(key), request.requestId);
  }

  @Post('config-revisions/:id/rollback')
  rollbackConfig(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: SpottRequest,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
  ) {
    const { reason } = z.object({ reason: z.string().min(3).max(2000) }).parse(body);
    return this.ops.rollbackConfig(user, id, this.idempotencyKey(key), reason, request.requestId);
  }

  @Get('analytics/overview')
  analyticsOverview(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('region') region?: string,
  ) {
    return this.ops.analyticsOverview(user, from, to, region);
  }

  @Get('audit-logs')
  auditLogs(
    @CurrentUser() user: AuthenticatedUser,
    @Query('q') q?: string,
    @Query('actorId') actorId?: string,
    @Query('action') action?: string,
    @Query('resource') resource?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.ops.auditLogs(user, { q, actorId, action, resource, from, to }, cursor, this.limit(limit));
  }

  @Get('admin-users')
  adminUsers(@CurrentUser() user: AuthenticatedUser) {
    return this.ops.adminUsers(user);
  }

  @Get('session')
  session(@CurrentUser() user: AuthenticatedUser) {
    return this.ops.session(user);
  }

  @Get('exports')
  exports(
    @CurrentUser() user: AuthenticatedUser,
    @Query('state') state?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.ops.exports(user, state, cursor, this.limit(limit));
  }

  @Post('exports')
  createExport(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: SpottRequest,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
  ) {
    const input = z.object({
      dataset: z.enum(['event_roster', 'safety_summary', 'points_reconciliation', 'audit_log']),
      filters: z.record(z.string(), z.unknown()).default({}),
      purpose: z.string().min(3).max(1000),
      expiresInHours: z.number().int().min(1).max(168),
      maxDownloads: z.number().int().min(1).max(5),
    }).parse(body);
    return this.ops.createExport(user, this.idempotencyKey(key), input, request.requestId);
  }

  @Post('exports/:id/approve')
  @HttpCode(200)
  approveExport(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: SpottRequest,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
  ) {
    const input = z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().min(3).max(2000) }).parse(body);
    return this.ops.approveExport(user, id, this.idempotencyKey(key), input, request.requestId);
  }

  @Get('exports/:id/download-ticket')
  exportDownloadTicket(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: SpottRequest,
    @Param('id') id: string,
    @Query('purpose') purpose?: string,
  ) {
    return this.ops.exportDownloadTicket(user, id, z.string().min(3).max(1000).parse(purpose), request.requestId);
  }

  private version(value: string | undefined): number {
    const match = value?.match(/^"([1-9][0-9]*)"$/);
    if (!match) throw new DomainError('VERSION_REQUIRED', '请求缺少有效的 If-Match 版本。', 400);
    return Number(match[1]);
  }

  private idempotencyKey(value: string | undefined): string {
    const parsed = z.string().uuid().safeParse(value);
    if (!parsed.success) throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', '请求缺少有效的幂等键。', 400);
    return parsed.data;
  }

  private limit(value: string | undefined): number {
    return value === undefined ? 20 : z.coerce.number().int().min(1).max(100).parse(value);
  }

  private setSessionCookies(reply: FastifyReply, session: SessionResponse): void {
    reply.header('Set-Cookie', [
      `__Host-spott_ops=${encodeURIComponent(session.accessToken)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=900`,
      `__Host-spott_ops_refresh=${encodeURIComponent(session.refreshToken)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`,
    ]);
  }

  private opsSessionResponse(session: SessionResponse): unknown {
    return {
      sessionId: session.sessionId,
      accessTokenExpiresAt: session.accessTokenExpiresAt,
      user: session.user,
    };
  }

  private cookie(header: string | undefined, name: string): string | undefined {
    const entry = header?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
    if (!entry) return undefined;
    try {
      return decodeURIComponent(entry.slice(name.length + 1));
    } catch {
      throw new DomainError('TOKEN_INVALID', '运营会话无效。', 401);
    }
  }
}
