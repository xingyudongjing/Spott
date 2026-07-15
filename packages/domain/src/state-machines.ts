import { DomainError } from './errors.js';
import type { EventStatus, RegistrationStatus } from './types.js';

const eventTransitions: Readonly<Record<EventStatus, readonly EventStatus[]>> = {
  draft: ['pending_review', 'deleted'],
  pending_review: ['needs_changes', 'published', 'rejected', 'draft'],
  needs_changes: ['pending_review', 'draft', 'deleted'],
  published: ['registration_closed', 'in_progress', 'cancelled', 'removed'],
  registration_closed: ['in_progress', 'cancelled', 'removed'],
  in_progress: ['ended', 'cancelled', 'removed'],
  ended: ['archived', 'removed'],
  cancelled: ['archived'],
  removed: ['appeal_pending', 'archived'],
  appeal_pending: ['removed', 'archived'],
  archived: [],
  deleted: [],
  rejected: ['draft', 'archived'],
};

const registrationTransitions: Readonly<Record<RegistrationStatus, readonly RegistrationStatus[]>> = {
  filling: ['pending', 'confirmed', 'waitlisted'],
  pending: ['confirmed', 'rejected', 'cancelled'],
  confirmed: ['checked_in', 'cancelled', 'no_show', 'event_cancelled'],
  waitlisted: ['offered', 'cancelled', 'event_cancelled'],
  offered: ['confirmed', 'waitlisted', 'expired', 'cancelled'],
  checked_in: ['attendance_disputed'],
  no_show: ['correction_pending', 'checked_in'],
  event_cancelled: ['final'],
  cancelled: [],
  rejected: [],
  expired: ['waitlisted'],
  correction_pending: ['checked_in', 'no_show'],
  attendance_disputed: ['checked_in', 'no_show'],
  final: [],
};

export function canTransitionEvent(from: EventStatus, to: EventStatus): boolean {
  return eventTransitions[from].includes(to);
}

export function transitionEvent(from: EventStatus, to: EventStatus): EventStatus {
  if (!canTransitionEvent(from, to)) {
    throw new DomainError(
      'INVALID_STATE_TRANSITION',
      `活动不能从 ${from} 进入 ${to}。`,
      422,
      { meta: { from, to, aggregate: 'event' } },
    );
  }
  return to;
}

export function canTransitionRegistration(
  from: RegistrationStatus,
  to: RegistrationStatus,
): boolean {
  return registrationTransitions[from].includes(to);
}

export function transitionRegistration(
  from: RegistrationStatus,
  to: RegistrationStatus,
): RegistrationStatus {
  if (!canTransitionRegistration(from, to)) {
    throw new DomainError(
      'INVALID_STATE_TRANSITION',
      `报名不能从 ${from} 进入 ${to}。`,
      422,
      { meta: { from, to, aggregate: 'registration' } },
    );
  }
  return to;
}
