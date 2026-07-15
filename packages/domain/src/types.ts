export type UUID = string;
export type RFC3339 = string;

export const eventStatuses = [
  'draft',
  'pending_review',
  'needs_changes',
  'published',
  'registration_closed',
  'in_progress',
  'ended',
  'cancelled',
  'removed',
  'appeal_pending',
  'archived',
  'deleted',
  'rejected',
] as const;

export type EventStatus = (typeof eventStatuses)[number];

export const registrationStatuses = [
  'filling',
  'pending',
  'confirmed',
  'waitlisted',
  'offered',
  'checked_in',
  'cancelled',
  'rejected',
  'expired',
  'no_show',
  'correction_pending',
  'attendance_disputed',
  'event_cancelled',
  'final',
] as const;

export type RegistrationStatus = (typeof registrationStatuses)[number];

export type RestrictionFlag =
  | 'loginBlocked'
  | 'publishBlocked'
  | 'registerBlocked'
  | 'pointsBlocked'
  | 'commentBlocked';

export type Role = 'guest' | 'user' | 'verified' | 'host' | 'groupOwner' | 'operator';

export type AvailableAction =
  | 'register'
  | 'joinWaitlist'
  | 'cancelRegistration'
  | 'viewTicket'
  | 'checkIn'
  | 'edit'
  | 'submit'
  | 'cancelEvent'
  | 'appeal'
  | 'joinGroup';

export interface VersionedEntity {
  id: UUID;
  version: number;
  createdAt: RFC3339;
  updatedAt: RFC3339;
  deletedAt?: RFC3339;
}

export interface EventSummary extends VersionedEntity {
  publicSlug: string;
  organizerId: UUID;
  status: EventStatus;
  title: string;
  description: string;
  region: string;
  publicArea: string;
  startsAt: RFC3339;
  endsAt: RFC3339;
  capacity: number;
  confirmedCount: number;
  priceLabel: string;
  feeBoundary?: string;
  coverURL?: string;
  tags: string[];
  availableActions: AvailableAction[];
}

export interface Registration extends VersionedEntity {
  eventId: UUID;
  userId: UUID;
  status: RegistrationStatus;
  partySize: number;
  waitlistJoinedAt?: RFC3339;
  availableActions: AvailableAction[];
}

export interface DomainErrorShape {
  code: string;
  message: string;
  retryable: boolean;
  fieldErrors: Array<{ field: string; message: string }>;
  actions: Array<{ type: string; label: string }>;
  meta: Record<string, unknown>;
}
