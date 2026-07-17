import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Public, type AuthenticatedUser } from '../../platform/request-context.js';
import { TicketsService } from './tickets.service.js';

const ticketTypeBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).optional(),
    isFree: z.boolean(),
    amountJPY: z.number().int().positive().optional(),
    collectorName: z.string().trim().max(120).optional(),
    method: z.string().trim().max(120).optional(),
    paymentDeadlineText: z.string().trim().max(240).optional(),
    refundPolicy: z.string().trim().max(4000).optional(),
    quota: z.number().int().positive().optional(),
  })
  .strict();

const ticketTypeUpdateBody = ticketTypeBody.partial().extend({ active: z.boolean().optional() });

@Controller()
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Public()
  @Get('events/:id/ticket-types')
  list(@Param('id') eventId: string) {
    return this.tickets.list(eventId);
  }

  @Post('events/:id/ticket-types')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') eventId: string,
    @Body() body: unknown,
  ) {
    const input = ticketTypeBody.parse(body);
    return this.tickets.create(user, eventId, input);
  }

  @Patch('ticket-types/:id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') ticketTypeId: string,
    @Body() body: unknown,
  ) {
    const input = ticketTypeUpdateBody.parse(body);
    return this.tickets.update(user, ticketTypeId, input);
  }

  @Post('registrations/:id/payment-report')
  reportPayment(@CurrentUser() user: AuthenticatedUser, @Param('id') registrationId: string) {
    return this.tickets.reportPayment(user, registrationId);
  }

  @Post('registrations/:id/payment-confirmation')
  confirmPayment(@CurrentUser() user: AuthenticatedUser, @Param('id') registrationId: string) {
    return this.tickets.confirmPayment(user, registrationId);
  }
}
