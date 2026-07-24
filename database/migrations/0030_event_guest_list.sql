BEGIN;

-- "Who's coming" social proof (Luma signature). Organizers may hide the guest
-- list; when hidden the public going-preview endpoint returns the confirmed
-- count only and never exposes attendee identities.
ALTER TABLE events.events
  ADD COLUMN IF NOT EXISTS show_guest_list boolean NOT NULL DEFAULT true;

COMMIT;
