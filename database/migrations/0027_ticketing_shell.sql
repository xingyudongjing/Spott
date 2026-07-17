-- Ticketing shell: multiple ticket types per event with independent per-type quotas,
-- plus off-platform payment status records on registrations.
--
-- Product boundary (owner ruling 2026-07-17): Spott is NOT a payment processor. Ticket types
-- extend the existing single-row events.event_fees disclosure model into several named tiers,
-- but the money still changes hands OFF the platform. These tables only DISCLOSE the organizer's
-- external price and terms and RECORD self-reported / host-confirmed payment status for attendance
-- management. They deliberately carry no platform balance, settlement, payout, or commission
-- column, and nothing here is a receipt or a guarantee of payment.
BEGIN;

-- One row per ticket tier of an event. amount_jpy / collector_name / method / payment_deadline_text
-- / refund_policy mirror events.event_fees exactly: they are the organizer's own external terms,
-- shown to users for information only. quota is the tier's own headcount ceiling (NULL = the tier
-- is only bounded by the event capacity). sold_count tracks live holders (pending + confirmed +
-- checked_in) of this tier and is maintained by the registration flow under a row lock.
CREATE TABLE events.ticket_types (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  event_id uuid NOT NULL REFERENCES events.events(id) ON DELETE CASCADE,
  name varchar(80) NOT NULL,
  description varchar(500),
  is_free boolean NOT NULL,
  amount_jpy bigint,
  collector_name varchar(120),
  method varchar(120),
  payment_deadline_text varchar(240),
  refund_policy text,
  quota integer,
  sold_count integer NOT NULL DEFAULT 0 CHECK (sold_count >= 0),
  sort_order smallint NOT NULL CHECK (sort_order >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (name <> ''),
  CHECK (quota IS NULL OR quota > 0),
  CHECK (quota IS NULL OR sold_count <= quota),
  -- Non-custody money shape, identical to events.event_fees: a free tier carries no price or
  -- collector; a paid tier must disclose a positive amount, an external collector and a method.
  CHECK (
    (is_free AND amount_jpy IS NULL AND collector_name IS NULL AND method IS NULL)
    OR
    (NOT is_free AND amount_jpy > 0 AND collector_name IS NOT NULL AND method IS NOT NULL
      AND refund_policy IS NOT NULL)
  ),
  UNIQUE (event_id, sort_order)
);
CREATE INDEX ix_ticket_types_event ON events.ticket_types(event_id);

COMMENT ON TABLE events.ticket_types IS
  'Ticket tiers for an event. Discloses the organizer''s OFF-PLATFORM price and terms only; Spott does not collect, hold, refund or take commission on any of it.';
COMMENT ON COLUMN events.ticket_types.sold_count IS
  'Live holders (pending + confirmed + checked_in) of this tier, maintained by the registration flow under a row lock.';

-- Which tier a registration selected. NULL keeps the pre-ticketing single-fee behaviour intact for
-- events that never define tiers. ON DELETE RESTRICT via the default: a tier with holders cannot be
-- hard-deleted (organizers archive by setting active = false instead).
ALTER TABLE events.registrations
  ADD COLUMN ticket_type_id uuid REFERENCES events.ticket_types(id);
CREATE INDEX ix_registrations_ticket_type ON events.registrations(ticket_type_id)
  WHERE ticket_type_id IS NOT NULL;

-- Off-platform payment status, recorded for attendance management only (product doc J2). These are
-- NOT platform receipts and carry no money: the attendee self-reports "paid" and the organizer
-- confirms "received" against their own external channel.
ALTER TABLE events.registrations
  ADD COLUMN payment_self_reported_at timestamptz,
  ADD COLUMN payment_confirmed_at timestamptz,
  ADD COLUMN payment_confirmed_by uuid REFERENCES identity.users(id);

COMMENT ON COLUMN events.registrations.payment_self_reported_at IS
  'When the attendee self-reported paying the organizer off-platform. Not a platform receipt.';
COMMENT ON COLUMN events.registrations.payment_confirmed_at IS
  'When the organizer confirmed receiving the off-platform payment. Not a platform receipt or guarantee.';

COMMIT;
