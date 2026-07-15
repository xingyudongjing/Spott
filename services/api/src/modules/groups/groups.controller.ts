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
import { DomainError } from '@spott/domain';
import { z } from 'zod';
import {
  CurrentUser,
  Public,
  type AuthenticatedUser,
  type SpottRequest,
} from '../../platform/request-context.js';
import { GroupsService } from './groups.service.js';

@Controller()
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  @Public()
  @Get('groups')
  discover(
    @Req() request: SpottRequest,
    @Query('region') region?: string,
    @Query('category') category?: string,
    @Query('q') query?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.groups.discover(request.user?.id, {
      region,
      category,
      query,
      cursor,
      limit: limit ? Number(limit) : 20,
    });
  }

  @Public()
  @Get('groups/:id')
  get(@Req() request: SpottRequest, @Param('id') id: string) {
    return this.groups.get(id, request.user?.id);
  }

  @Get('me/groups')
  mine(@CurrentUser() user: AuthenticatedUser) {
    return this.groups.mine(user.id);
  }

  @Post('groups')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
  ) {
    const input = z.object({
      quoteId: z.string().uuid(),
      name: z.string().trim().min(2).max(30),
      slug: z.string().regex(/^[a-z0-9-]{3,80}$/),
      description: z.string().trim().min(20).max(1000),
      joinMode: z.enum(['open', 'approval', 'invite_only']),
      regionId: z.string().min(1).max(80).default('nationwide'),
      categoryId: z.string().min(1).max(80),
      tags: z.array(z.string().min(1).max(40)).max(5).default([]),
      rules: z.string().max(4000).default(''),
    }).parse(body);
    return this.groups.create(user, this.key(key), input);
  }

  @Post('groups/:id/join')
  join(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
  ) {
    const input = z.object({ inviteCode: z.string().min(8).max(100).optional() }).default({}).parse(body ?? {});
    return this.groups.join(user, id, this.key(key), input.inviteCode);
  }

  @Post('groups/:id/invites')
  invite(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    const input = z.object({
      maxUses: z.number().int().min(1).max(1000).default(1),
      expiresInHours: z.number().int().min(1).max(24 * 30).default(168),
    }).parse(body);
    return this.groups.createInvite(user, id, input);
  }

  @Patch('groups/:id/members/:userId')
  updateMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ) {
    const input = z.object({
      role: z.enum(['admin', 'member']).optional(),
      status: z.enum(['active', 'muted', 'removed']).optional(),
    }).refine((value) => value.role !== undefined || value.status !== undefined).parse(body);
    return this.groups.updateMember(user, id, userId, input);
  }

  @Get('groups/:id/members')
  members(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.groups.members(user, id, cursor, limit ? Number(limit) : 50);
  }

  @Post('groups/:id/capacity-purchases')
  capacity(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
  ) {
    const input = z.object({ quoteId: z.string().uuid() }).parse(body);
    return this.groups.purchaseCapacity(user, id, input.quoteId, this.key(key));
  }

  @Put('groups/:id/follow')
  follow(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.groups.setFollow(user.id, id, true);
  }

  @Delete('groups/:id/follow')
  unfollow(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.groups.setFollow(user.id, id, false);
  }

  @Public()
  @Get('groups/:id/announcements')
  announcements(
    @Req() request: SpottRequest,
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.groups.announcements(id, request.user?.id, cursor, limit ? Number(limit) : 20);
  }

  @Post('groups/:id/announcements')
  createAnnouncement(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
  ) {
    const input = z.object({
      title: z.string().trim().min(2).max(120),
      body: z.string().trim().min(1).max(4000),
      visibility: z.enum(['public', 'members']).default('members'),
      commentsEnabled: z.boolean().default(true),
    }).parse(body);
    return this.groups.createAnnouncement(user, id, this.key(key), input);
  }

  @Patch('groups/:id/announcements/:announcementId')
  updateAnnouncement(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('announcementId') announcementId: string,
    @Headers('if-match') ifMatch: string,
    @Body() body: unknown,
  ) {
    const input = z.object({
      title: z.string().trim().min(2).max(120).optional(),
      body: z.string().trim().min(1).max(4000).optional(),
      visibility: z.enum(['public', 'members']).optional(),
      commentsEnabled: z.boolean().optional(),
    }).parse(body);
    return this.groups.updateAnnouncement(user, id, announcementId, this.version(ifMatch), input);
  }

  @Delete('groups/:id/announcements/:announcementId')
  @HttpCode(204)
  async deleteAnnouncement(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('announcementId') announcementId: string,
  ): Promise<void> {
    await this.groups.deleteAnnouncement(user, id, announcementId);
  }

  @Public()
  @Get('groups/:id/announcements/:announcementId/comments')
  comments(
    @Req() request: SpottRequest,
    @Param('id') id: string,
    @Param('announcementId') announcementId: string,
  ) {
    return this.groups.comments(id, announcementId, request.user?.id);
  }

  @Post('groups/:id/announcements/:announcementId/comments')
  createComment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('announcementId') announcementId: string,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
  ) {
    const input = z.object({
      body: z.string().trim().min(1).max(2000),
      parentId: z.string().uuid().optional(),
      locale: z.enum(['zh-Hans', 'ja', 'en']).default('zh-Hans'),
    }).parse(body);
    return this.groups.createComment(user, id, announcementId, this.key(key), input);
  }

  @Patch('comments/:commentId')
  updateComment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('commentId') commentId: string,
    @Headers('if-match') ifMatch: string,
    @Body() body: unknown,
  ) {
    const input = z.object({ body: z.string().trim().min(1).max(2000) }).parse(body);
    return this.groups.updateComment(user, commentId, this.version(ifMatch), input.body);
  }

  @Delete('comments/:commentId')
  @HttpCode(204)
  async deleteComment(@CurrentUser() user: AuthenticatedUser, @Param('commentId') commentId: string): Promise<void> {
    await this.groups.deleteComment(user, commentId);
  }

  @Put('groups/:id/announcements/:announcementId/like')
  likeAnnouncement(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('announcementId') announcementId: string,
  ) {
    return this.groups.setAnnouncementLike(user.id, id, announcementId, true);
  }

  @Delete('groups/:id/announcements/:announcementId/like')
  unlikeAnnouncement(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('announcementId') announcementId: string,
  ) {
    return this.groups.setAnnouncementLike(user.id, id, announcementId, false);
  }

  @Post('groups/:id/transfers')
  transfer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = z.object({ targetUserId: z.string().uuid() }).parse(body);
    return this.groups.startTransfer(user, id, input.targetUserId);
  }

  @Get('groups/:id/transfers/active')
  activeTransfer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.groups.activeTransfer(user, id);
  }

  @Post('groups/:id/transfers/:transferId/accept')
  acceptTransfer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('transferId') transferId: string,
  ) {
    return this.groups.acceptTransfer(user, id, transferId);
  }

  @Post('groups/:id/transfers/:transferId/complete')
  completeTransfer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('transferId') transferId: string,
  ) {
    return this.groups.completeTransfer(user, id, transferId);
  }

  @Post('groups/:id/transfers/:transferId/cancel')
  cancelTransfer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('transferId') transferId: string,
    @Body() body: unknown,
  ) {
    const input = z.object({ reason: z.string().trim().min(2).max(500) }).parse(body);
    return this.groups.cancelTransfer(user, id, transferId, input.reason);
  }

  @Post('groups/:id/dissolution')
  dissolve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = z.object({ reason: z.string().trim().min(3).max(1000) }).parse(body);
    return this.groups.requestDissolution(user, id, input.reason);
  }

  @Delete('groups/:id/dissolution')
  cancelDissolution(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.groups.cancelDissolution(user, id);
  }

  @Post('groups/:id/dissolution/finalize')
  finalizeDissolution(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.groups.finalizeDissolution(user, id);
  }

  private key(value: string | undefined): string {
    if (!value || !z.string().uuid().safeParse(value).success) {
      throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', '请求缺少有效的幂等键。', 400);
    }
    return value;
  }

  private version(value: string | undefined): number {
    const match = value?.match(/^"([1-9][0-9]*)"$/);
    if (!match) throw new DomainError('VERSION_REQUIRED', '请求缺少有效的 If-Match 版本。', 400);
    return Number(match[1]);
  }
}
