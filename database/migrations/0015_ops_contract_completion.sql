-- Complete the audited operations-console workflow contracts.
BEGIN;

ALTER TABLE admin.point_adjustment_requests
  ADD COLUMN IF NOT EXISTS evidence_ref text,
  ADD COLUMN IF NOT EXISTS decision_reason text,
  ADD COLUMN IF NOT EXISTS failure_code text,
  ADD COLUMN IF NOT EXISTS required_approvals smallint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS approval_count smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE admin.point_adjustment_requests DROP CONSTRAINT IF EXISTS point_adjustment_required_approvals_check;
ALTER TABLE admin.point_adjustment_requests ADD CONSTRAINT point_adjustment_required_approvals_check
  CHECK (required_approvals BETWEEN 1 AND 2);
ALTER TABLE admin.point_adjustment_requests DROP CONSTRAINT IF EXISTS point_adjustment_approval_count_check;
ALTER TABLE admin.point_adjustment_requests ADD CONSTRAINT point_adjustment_approval_count_check
  CHECK (approval_count BETWEEN 0 AND required_approvals);
DROP TRIGGER IF EXISTS trg_point_adjustment_version ON admin.point_adjustment_requests;
CREATE TRIGGER trg_point_adjustment_version BEFORE UPDATE ON admin.point_adjustment_requests
FOR EACH ROW EXECUTE FUNCTION spott.touch_version();
CREATE INDEX IF NOT EXISTS ix_point_adjustments_queue
  ON admin.point_adjustment_requests(state, created_at DESC, id);

CREATE TABLE IF NOT EXISTS admin.point_adjustment_approvals (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  request_id uuid NOT NULL REFERENCES admin.point_adjustment_requests(id),
  approver_id uuid NOT NULL REFERENCES admin.admin_users(id),
  decision text NOT NULL CHECK (decision IN ('approve','reject')),
  reason varchar(2000) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (request_id, approver_id)
);
CREATE TRIGGER trg_point_adjustment_approvals_immutable
BEFORE UPDATE OR DELETE ON admin.point_adjustment_approvals
FOR EACH ROW EXECUTE FUNCTION spott.prevent_mutation();

ALTER TABLE admin.config_revisions
  ADD COLUMN IF NOT EXISTS reason varchar(2000) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE INDEX IF NOT EXISTS ix_config_revisions_queue
  ON admin.config_revisions(state, created_at DESC, id);

ALTER TABLE admin.exports
  ADD COLUMN IF NOT EXISTS dataset text,
  ADD COLUMN IF NOT EXISTS filters_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS decision_reason varchar(2000),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT clock_timestamp();
UPDATE admin.exports SET dataset = COALESCE(dataset, 'audit_log') WHERE dataset IS NULL;
ALTER TABLE admin.exports ALTER COLUMN dataset SET NOT NULL;
ALTER TABLE admin.exports DROP CONSTRAINT IF EXISTS exports_dataset_check;
ALTER TABLE admin.exports ADD CONSTRAINT exports_dataset_check
  CHECK (dataset IN ('event_roster','safety_summary','points_reconciliation','audit_log'));
ALTER TABLE admin.exports DROP CONSTRAINT IF EXISTS exports_state_check;
ALTER TABLE admin.exports ADD CONSTRAINT exports_state_check
  CHECK (state IN ('pending','approved','rejected','ready','expired','failed'));
ALTER TABLE admin.exports DROP CONSTRAINT IF EXISTS exports_filters_json_check;
ALTER TABLE admin.exports ADD CONSTRAINT exports_filters_json_check
  CHECK (jsonb_typeof(filters_json) = 'object');
CREATE INDEX IF NOT EXISTS ix_exports_queue ON admin.exports(state, created_at DESC, id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'moderation_cases_assignee_id_fkey'
      AND conrelid = 'safety.moderation_cases'::regclass
  ) THEN
    ALTER TABLE safety.moderation_cases
      ADD CONSTRAINT moderation_cases_assignee_id_fkey
      FOREIGN KEY (assignee_id) REFERENCES admin.admin_users(id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS ix_moderation_cases_assignee
  ON safety.moderation_cases(assignee_id, status, sla_due_at);

-- Event approval creates one recoverable automatic poster job without blocking
-- users from creating other templates manually.
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_approval_poster_job
  ON growth.poster_jobs(resource_id)
  WHERE resource_type = 'event' AND template = 'event_approved';

INSERT INTO notification.templates(type,locale,version,title_template,body_template)
VALUES
  ('poster.ready','zh-Hans',1,'活动分享海报已生成','{{title}} 的分享海报已经可以使用。'),
  ('poster.ready','ja',1,'イベントの共有ポスターが完成しました','{{title}} の共有ポスターを利用できます。'),
  ('poster.ready','en',1,'Your event poster is ready','The share poster for {{title}} is ready to use.')
ON CONFLICT (type,locale,version) DO NOTHING;

COMMIT;
