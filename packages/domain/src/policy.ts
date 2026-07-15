import type { AvailableAction, EventStatus, RestrictionFlag, Role } from './types.js';

export interface PolicySubject {
  authenticated: boolean;
  phoneVerified: boolean;
  roles: readonly Role[];
  restrictions: ReadonlySet<RestrictionFlag>;
  userId?: string;
}

export interface EventPolicyResource {
  organizerId: string;
  status: EventStatus;
  registrationOpen: boolean;
  waitlistEnabled: boolean;
  isFull: boolean;
  registrationStatus?: string | null;
}

export function availableEventActions(
  subject: PolicySubject,
  event: EventPolicyResource,
): AvailableAction[] {
  const actions: AvailableAction[] = [];
  const isOrganizer = subject.userId === event.organizerId;
  const isParticipant = Boolean(event.registrationStatus);

  if (isOrganizer && !subject.restrictions.has('publishBlocked')) {
    if (['draft', 'needs_changes'].includes(event.status)) actions.push('edit', 'submit');
    if (['published', 'registration_closed', 'in_progress'].includes(event.status)) {
      actions.push('edit', 'cancelEvent');
    }
  }

  if (
    subject.authenticated &&
    subject.phoneVerified &&
    !subject.restrictions.has('registerBlocked') &&
    event.status === 'published' &&
    event.registrationOpen &&
    !isOrganizer &&
    !isParticipant
  ) {
    if (!event.isFull) actions.push('register');
    else if (event.waitlistEnabled) actions.push('joinWaitlist');
  }

  if (['pending', 'confirmed', 'waitlisted', 'offered'].includes(event.registrationStatus ?? '')) {
    actions.push('cancelRegistration');
  }
  if (['confirmed', 'checked_in'].includes(event.registrationStatus ?? '')) actions.push('viewTicket');

  if (event.status === 'removed') actions.push('appeal');
  return actions;
}

export function canReadExactAddress(
  registrationStatus: string | undefined,
  eventStatus: EventStatus,
): boolean {
  return (
    (registrationStatus === 'confirmed' || registrationStatus === 'checked_in') &&
    eventStatus !== 'removed' &&
    eventStatus !== 'cancelled'
  );
}
