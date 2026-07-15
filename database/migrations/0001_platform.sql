-- REQ-DATA-001, REQ-SYNC-001, REQ-NFR-001
-- PostgreSQL 18.4 baseline. This migration is append-only after deployment.
BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS events;
CREATE SCHEMA IF NOT EXISTS community;
CREATE SCHEMA IF NOT EXISTS commerce;
CREATE SCHEMA IF NOT EXISTS safety;
CREATE SCHEMA IF NOT EXISTS notification;
CREATE SCHEMA IF NOT EXISTS growth;
CREATE SCHEMA IF NOT EXISTS admin;
CREATE SCHEMA IF NOT EXISTS sync;
CREATE SCHEMA IF NOT EXISTS analytics;
CREATE SCHEMA IF NOT EXISTS spott;

CREATE TYPE identity.user_status AS ENUM (
  'active', 'deletion_pending', 'restricted', 'suspended', 'anonymized'
);
CREATE TYPE identity.identity_provider AS ENUM ('apple', 'google', 'email');
CREATE TYPE events.event_status AS ENUM (
  'draft', 'pending_review', 'needs_changes', 'published', 'registration_closed',
  'in_progress', 'ended', 'cancelled', 'removed', 'appeal_pending', 'archived',
  'deleted', 'rejected'
);
CREATE TYPE events.registration_status AS ENUM (
  'filling', 'pending', 'confirmed', 'waitlisted', 'offered', 'checked_in',
  'cancelled', 'rejected', 'expired', 'no_show', 'correction_pending',
  'attendance_disputed', 'event_cancelled', 'final'
);
CREATE TYPE events.review_state AS ENUM ('unreviewed', 'pending', 'approved', 'rejected');
CREATE TYPE community.group_status AS ENUM ('active', 'transfer_pending', 'closing', 'dissolved', 'removed');
CREATE TYPE community.membership_status AS ENUM ('pending', 'active', 'muted', 'removed', 'left');
CREATE TYPE community.group_role AS ENUM ('owner', 'admin', 'member');
CREATE TYPE commerce.point_bucket AS ENUM ('paid', 'free');
CREATE TYPE commerce.transaction_status AS ENUM ('pending', 'posted', 'reversed', 'failed');
CREATE TYPE commerce.hold_state AS ENUM ('active', 'captured', 'released', 'expired');
CREATE TYPE safety.case_status AS ENUM ('open', 'claimed', 'decided', 'appealed', 'closed');
CREATE TYPE safety.severity AS ENUM ('p0', 'p1', 'p2');
CREATE TYPE notification.delivery_state AS ENUM ('queued', 'sending', 'delivered', 'failed', 'suppressed');
CREATE TYPE sync.change_operation AS ENUM ('upsert', 'tombstone');

CREATE OR REPLACE FUNCTION spott.touch_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.version := OLD.version + 1;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION spott.prevent_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

COMMIT;
