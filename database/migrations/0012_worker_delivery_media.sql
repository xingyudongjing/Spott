-- Durable media processing, notification deduplication and announcement fan-out.
BEGIN;

ALTER TABLE media.assets
  ADD COLUMN IF NOT EXISTS processing_attempts smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS processing_available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN IF NOT EXISTS processing_locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS processing_locked_by text,
  ADD COLUMN IF NOT EXISTS failure_code text,
  ADD COLUMN IF NOT EXISTS scan_state text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS scan_details jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE media.assets DROP CONSTRAINT IF EXISTS media_assets_processing_attempts_check;
ALTER TABLE media.assets ADD CONSTRAINT media_assets_processing_attempts_check
  CHECK (processing_attempts BETWEEN 0 AND 20);
ALTER TABLE media.assets DROP CONSTRAINT IF EXISTS media_assets_scan_state_check;
ALTER TABLE media.assets ADD CONSTRAINT media_assets_scan_state_check
  CHECK (scan_state IN ('pending','scanning','clean','infected','failed','skipped'));
ALTER TABLE media.assets DROP CONSTRAINT IF EXISTS media_assets_scan_details_check;
ALTER TABLE media.assets ADD CONSTRAINT media_assets_scan_details_check
  CHECK (jsonb_typeof(scan_details) = 'object');

DROP INDEX IF EXISTS media.ix_media_assets_processing;
CREATE INDEX IF NOT EXISTS ix_media_assets_processing ON media.assets(processing_available_at, created_at)
  WHERE state IN ('uploaded','processing');

ALTER TABLE notification.notifications ADD COLUMN IF NOT EXISTS dedupe_key text;
UPDATE notification.notifications
SET dedupe_key = COALESCE(payload_ref->>'dedupeKey', id::text)
WHERE dedupe_key IS NULL;
ALTER TABLE notification.notifications ALTER COLUMN dedupe_key SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_dedupe
  ON notification.notifications(user_id, type, dedupe_key);

CREATE TABLE IF NOT EXISTS notification.fanout_receipts (
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  recipient_count integer NOT NULL DEFAULT 0 CHECK (recipient_count >= 0),
  processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (source_type, source_id)
);

INSERT INTO notification.templates(type, locale, version, title_template, body_template)
VALUES
  ('event.reminder.24h','zh-Hans',1,'活动将在明天开始','{{title}} · {{startsAt}}'),
  ('event.reminder.24h','ja',1,'イベントは明日です','{{title}} · {{startsAt}}'),
  ('event.reminder.24h','en',1,'Your event starts tomorrow','{{title}} · {{startsAt}}'),
  ('event.reminder.2h','zh-Hans',1,'活动将在 2 小时后开始','{{title}} · {{publicArea}}'),
  ('event.reminder.2h','ja',1,'イベント開始まであと2時間','{{title}} · {{publicArea}}'),
  ('event.reminder.2h','en',1,'Your event starts in 2 hours','{{title}} · {{publicArea}}'),
  ('waitlist.offered','zh-Hans',1,'候补席位已为你保留','请在 2 小时内确认，逾期将自动顺延。'),
  ('waitlist.offered','ja',1,'キャンセル待ちの枠をご用意しました','2時間以内に参加を確定してください。'),
  ('waitlist.offered','en',1,'A waitlist spot is ready','Accept within 2 hours before it passes to the next guest.'),
  ('group.announcement','zh-Hans',1,'{{groupName}} 发布了新公告','{{body}}'),
  ('group.announcement','ja',1,'{{groupName}}から新しいお知らせ','{{body}}'),
  ('group.announcement','en',1,'New announcement from {{groupName}}','{{body}}')
ON CONFLICT (type, locale, version) DO NOTHING;

COMMIT;
