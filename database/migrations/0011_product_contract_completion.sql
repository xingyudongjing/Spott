-- Product-contract completion: points catalog, multilingual preferences,
-- registration questions, group community lifecycle, attendance and feedback privacy.
BEGIN;

-- The client locale is intentionally independent from the language of user-generated
-- content. V1 ships the same three UI locales on iOS and Web.
ALTER TABLE identity.profiles
  ADD COLUMN IF NOT EXISTS preferred_locale text NOT NULL DEFAULT 'zh-Hans',
  ADD COLUMN IF NOT EXISTS content_languages text[] NOT NULL DEFAULT ARRAY['zh-Hans']::text[];

UPDATE identity.profiles
SET preferred_locale = CASE source_language
  WHEN 'ja' THEN 'ja'
  WHEN 'en' THEN 'en'
  ELSE 'zh-Hans'
END
WHERE preferred_locale NOT IN ('zh-Hans', 'ja', 'en');

ALTER TABLE identity.profiles DROP CONSTRAINT IF EXISTS profiles_preferred_locale_check;
ALTER TABLE identity.profiles ADD CONSTRAINT profiles_preferred_locale_check
  CHECK (preferred_locale IN ('zh-Hans', 'ja', 'en'));
ALTER TABLE identity.profiles DROP CONSTRAINT IF EXISTS profiles_content_languages_check;
ALTER TABLE identity.profiles ADD CONSTRAINT profiles_content_languages_check
  CHECK (
    cardinality(content_languages) BETWEEN 1 AND 3
    AND content_languages <@ ARRAY['zh-Hans', 'ja', 'en']::text[]
  );

-- 0010 introduced the publication-contract table. Move legacy answers to that
-- canonical question set before changing the foreign key.
INSERT INTO events.registration_questions(id, event_id, prompt, kind, required, options, sort_order)
SELECT q.id, q.event_id, q.label,
  CASE q.type WHEN 'single_choice' THEN 'single_choice' WHEN 'boolean' THEN 'boolean' ELSE 'text' END,
  q.required, q.options, q.sort_order
FROM events.event_questions q
WHERE NOT EXISTS (
  SELECT 1 FROM events.registration_questions rq
  WHERE rq.event_id = q.event_id AND rq.sort_order = q.sort_order
)
ON CONFLICT DO NOTHING;

UPDATE events.registration_answers answer
SET question_id = canonical.id
FROM events.event_questions legacy
JOIN events.registration_questions canonical
  ON canonical.event_id = legacy.event_id AND canonical.sort_order = legacy.sort_order
WHERE answer.question_id = legacy.id;

ALTER TABLE events.registration_answers
  DROP CONSTRAINT IF EXISTS registration_answers_question_id_fkey;
DELETE FROM events.registration_answers answer
WHERE NOT EXISTS (
  SELECT 1 FROM events.registration_questions question WHERE question.id = answer.question_id
);
ALTER TABLE events.registration_answers
  ADD CONSTRAINT registration_answers_question_id_fkey
  FOREIGN KEY (question_id) REFERENCES events.registration_questions(id);

ALTER TABLE events.registration_questions
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE events.registration_questions DROP CONSTRAINT IF EXISTS registration_questions_options_check;
ALTER TABLE events.registration_questions ADD CONSTRAINT registration_questions_options_check
  CHECK (jsonb_typeof(options) = 'array');

ALTER TABLE events.registrations
  ADD COLUMN IF NOT EXISTS attendee_note varchar(1000);

-- An event has one cover plus at most five gallery images. The unique
-- (event_id, sort_order) constraint then makes the 1..6 aggregate deterministic.
ALTER TABLE events.event_media DROP CONSTRAINT IF EXISTS event_media_sort_order_check;
ALTER TABLE events.event_media ADD CONSTRAINT event_media_sort_order_check
  CHECK (sort_order BETWEEN 0 AND 5);

-- Dynamic QR and dynamic six-digit codes share the same 30-second lifecycle.
ALTER TABLE events.dynamic_checkin_codes
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'dynamic_qr',
  ADD COLUMN IF NOT EXISTS short_code_hash bytea;
ALTER TABLE events.dynamic_checkin_codes DROP CONSTRAINT IF EXISTS dynamic_checkin_codes_mode_check;
ALTER TABLE events.dynamic_checkin_codes ADD CONSTRAINT dynamic_checkin_codes_mode_check
  CHECK (mode IN ('dynamic_qr', 'six_digit'));
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_short_checkin_code
  ON events.dynamic_checkin_codes(event_id, short_code_hash)
  WHERE short_code_hash IS NOT NULL AND revoked_at IS NULL;

ALTER TABLE events.checkins DROP CONSTRAINT IF EXISTS checkins_method_check;
ALTER TABLE events.checkins ADD CONSTRAINT checkins_method_check
  CHECK (method IN ('dynamic_qr', 'six_digit', 'host_manual', 'offline_replay', 'correction'));

-- Public group discovery and the controlled community surface.
ALTER TABLE community.groups
  ADD COLUMN IF NOT EXISTS region_id text NOT NULL DEFAULT 'nationwide',
  ADD COLUMN IF NOT EXISTS category_id text,
  ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS rules varchar(4000) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS cover_asset_id uuid REFERENCES media.assets(id);
ALTER TABLE community.groups DROP CONSTRAINT IF EXISTS groups_capacity_check;
ALTER TABLE community.groups ADD CONSTRAINT groups_capacity_check
  CHECK (capacity BETWEEN 50 AND 500 AND capacity % 50 = 0);
ALTER TABLE community.groups DROP CONSTRAINT IF EXISTS groups_tags_check;
ALTER TABLE community.groups ADD CONSTRAINT groups_tags_check
  CHECK (cardinality(tags) <= 5);
ALTER TABLE community.groups DROP CONSTRAINT IF EXISTS groups_name_product_check;
ALTER TABLE community.groups ADD CONSTRAINT groups_name_product_check
  CHECK (char_length(name) BETWEEN 2 AND 30) NOT VALID;
ALTER TABLE community.groups DROP CONSTRAINT IF EXISTS groups_description_product_check;
ALTER TABLE community.groups ADD CONSTRAINT groups_description_product_check
  CHECK (char_length(description) BETWEEN 20 AND 1000) NOT VALID;
CREATE INDEX IF NOT EXISTS ix_groups_discovery
  ON community.groups(status, region_id, category_id, created_at DESC, id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_groups_name_trgm ON community.groups USING gin(name gin_trgm_ops);

ALTER TABLE community.announcements
  ADD COLUMN IF NOT EXISTS title varchar(120) NOT NULL DEFAULT '群组公告',
  ADD COLUMN IF NOT EXISTS comments_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS pinned_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES identity.users(id);
CREATE INDEX IF NOT EXISTS ix_announcements_group_created
  ON community.announcements(group_id, pinned_at DESC NULLS LAST, created_at DESC, id)
  WHERE deleted_at IS NULL;

ALTER TABLE community.comments
  ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES community.comments(id),
  ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES identity.users(id);
UPDATE community.comments SET source_language = 'zh-Hans'
WHERE source_language NOT IN ('zh-Hans', 'ja', 'en');
ALTER TABLE community.comments DROP CONSTRAINT IF EXISTS comments_source_language_check;
ALTER TABLE community.comments ADD CONSTRAINT comments_source_language_check
  CHECK (source_language IN ('zh-Hans', 'ja', 'en'));
CREATE INDEX IF NOT EXISTS ix_comments_target_created
  ON community.comments(target_type, target_id, created_at, id)
  WHERE deleted_at IS NULL AND status = 'visible';

CREATE TABLE IF NOT EXISTS community.announcement_reactions (
  announcement_id uuid NOT NULL REFERENCES community.announcements(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  reaction text NOT NULL DEFAULT 'like' CHECK (reaction = 'like'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (announcement_id, user_id)
);

CREATE TABLE IF NOT EXISTS community.group_invites (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  group_id uuid NOT NULL REFERENCES community.groups(id),
  code_hash bytea NOT NULL UNIQUE,
  created_by uuid NOT NULL REFERENCES identity.users(id),
  max_uses integer NOT NULL DEFAULT 1 CHECK (max_uses BETWEEN 1 AND 1000),
  used_count integer NOT NULL DEFAULT 0 CHECK (used_count >= 0 AND used_count <= max_uses),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE community.group_transfers
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES identity.users(id),
  ADD COLUMN IF NOT EXISTS cancel_reason text;

CREATE TABLE IF NOT EXISTS community.group_dissolutions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  group_id uuid NOT NULL REFERENCES community.groups(id),
  requested_by uuid NOT NULL REFERENCES identity.users(id),
  reason varchar(1000) NOT NULL,
  scheduled_for timestamptz NOT NULL,
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES identity.users(id),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (scheduled_for >= created_at + interval '7 days')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_group_dissolution
  ON community.group_dissolutions(group_id)
  WHERE cancelled_at IS NULL AND completed_at IS NULL;

-- Feedback text and raw rating are never exposed publicly. Public summaries use
-- approved structured tags only and are withheld until the sample threshold.
UPDATE community.feedback SET visibility = 'aggregate_only' WHERE visibility = 'public';
ALTER TABLE community.feedback
  ADD COLUMN IF NOT EXISTS edit_count smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_edited_at timestamptz;
ALTER TABLE community.feedback DROP CONSTRAINT IF EXISTS feedback_visibility_check;
ALTER TABLE community.feedback ADD CONSTRAINT feedback_visibility_check
  CHECK (visibility IN ('private', 'aggregate_only'));
ALTER TABLE community.feedback DROP CONSTRAINT IF EXISTS feedback_edit_count_check;
ALTER TABLE community.feedback ADD CONSTRAINT feedback_edit_count_check
  CHECK (edit_count BETWEEN 0 AND 1);
ALTER TABLE community.feedback DROP CONSTRAINT IF EXISTS feedback_private_comment_length_check;
ALTER TABLE community.feedback ADD CONSTRAINT feedback_private_comment_length_check
  CHECK (comment IS NULL OR char_length(comment) <= 500) NOT VALID;

-- Point rule catalog is the server-side baseline. Approved config revisions can
-- override every key without a client release; stage selects launch/stable values.
CREATE TABLE IF NOT EXISTS commerce.point_rule_catalog (
  key text PRIMARY KEY,
  rule_type text NOT NULL CHECK (rule_type IN ('reward', 'cost', 'limit', 'expiry', 'allowance')),
  launch_value bigint NOT NULL,
  stable_value bigint NOT NULL,
  unit text NOT NULL DEFAULT 'points',
  conditions jsonb NOT NULL DEFAULT '{}',
  description text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (jsonb_typeof(conditions) = 'object')
);

INSERT INTO commerce.point_rule_catalog(key, rule_type, launch_value, stable_value, unit, conditions, description)
VALUES
  ('points.reward.phone_verified', 'reward', 500, 500, 'points', '{"oncePerPhone":true}', '首次绑定日本手机号'),
  ('points.reward.profile_completed', 'reward', 100, 100, 'points', '{"oncePerAccount":true,"minimumInterests":3}', '完善个人资料'),
  ('points.reward.daily_checkin', 'reward', 10, 10, 'points', '{"japanCalendarDay":true}', '每日积分中心签到'),
  ('points.reward.streak_7', 'reward', 50, 50, 'points', '{"days":7}', '连续七日签到额外奖励'),
  ('points.reward.streak_30', 'reward', 200, 200, 'points', '{"days":30}', '连续三十日签到额外奖励'),
  ('points.reward.attendance', 'reward', 80, 80, 'points', '{"dailyMaxEvents":3}', '真实活动签到'),
  ('points.reward.feedback', 'reward', 20, 20, 'points', '{"weeklyMax":5}', '有效结构化反馈'),
  ('points.reward.host_completed', 'reward', 150, 150, 'points', '{"minimumCheckedIn":3,"weeklyMax":10}', '局头完成活动'),
  ('points.reward.host_verified', 'reward', 200, 200, 'points', '{"oncePerPerson":true}', '局头身份认证'),
  ('points.reward.referral', 'reward', 100, 100, 'points', '{"monthlyMax":5,"requiresFirstCheckin":true}', '有效邀请'),
  ('points.cost.registration', 'cost', 10, 10, 'points', '{"refundBeforeHours":24}', '报名活动'),
  ('points.cost.event_publish', 'cost', 100, 120, 'points', '{"holdUntilApproved":true}', '发布活动'),
  ('points.cost.group_create', 'cost', 300, 300, 'points', '{"initialCapacity":50}', '创建群组'),
  ('points.cost.group_capacity', 'cost', 200, 250, 'points', '{"capacityIncrement":50,"maximumCapacity":500}', '群组扩容五十人'),
  ('points.cost.poster', 'cost', 20, 20, 'points', '{"launchFreeMonthly":3,"stableFreeMonthly":1}', '超额海报生成'),
  ('points.cost.boost_24h', 'cost', 300, 500, 'points', '{"hours":24}', '活动置顶二十四小时'),
  ('points.cost.boost_72h', 'cost', 700, 1200, 'points', '{"hours":72}', '活动置顶七十二小时'),
  ('points.cost.boost_7d', 'cost', 1500, 2500, 'points', '{"days":7}', '活动置顶七天'),
  ('points.cost.extra_announcement', 'cost', 50, 80, 'points', '{"launchFreeMonthly":4,"stableFreeMonthly":2}', '额外群组全员公告'),
  ('points.cost.organizer_export', 'cost', 100, 100, 'points', '{"launchFreeMonthly":2,"stableFreeMonthly":0}', '组织者数据导出'),
  ('points.cost.event_detail', 'cost', 0, 2, 'points', '{"stableDailyFree":10,"neverGateDiscovery":true}', '稳定期超额活动详情'),
  ('points.limit.attendance.daily', 'limit', 3, 3, 'events', '{}', '每日可奖励真实签到场次'),
  ('points.limit.feedback.weekly', 'limit', 5, 5, 'feedback', '{}', '每周可奖励有效反馈次数'),
  ('points.limit.host_completed.weekly', 'limit', 10, 10, 'events', '{}', '每周可奖励完成活动场次'),
  ('points.expiry.free_days', 'expiry', 180, 180, 'days', '{}', '普通免费积分有效期'),
  ('points.expiry.launch_welcome_days', 'expiry', 90, 90, 'days', '{}', '上线欢迎积分有效期')
ON CONFLICT (key) DO UPDATE SET
  rule_type = EXCLUDED.rule_type,
  launch_value = EXCLUDED.launch_value,
  stable_value = EXCLUDED.stable_value,
  unit = EXCLUDED.unit,
  conditions = EXCLUDED.conditions,
  description = EXCLUDED.description,
  updated_at = clock_timestamp();

-- Enforce the V1 language contract for notification preferences and templates.
UPDATE notification.preferences SET locale = 'zh-Hans' WHERE locale NOT IN ('zh-Hans', 'ja', 'en');
ALTER TABLE notification.preferences DROP CONSTRAINT IF EXISTS preferences_locale_check;
ALTER TABLE notification.preferences ADD CONSTRAINT preferences_locale_check
  CHECK (locale IN ('zh-Hans', 'ja', 'en'));
UPDATE notification.templates SET locale = 'zh-Hans' WHERE locale NOT IN ('zh-Hans', 'ja', 'en');
ALTER TABLE notification.templates DROP CONSTRAINT IF EXISTS templates_locale_check;
ALTER TABLE notification.templates ADD CONSTRAINT templates_locale_check
  CHECK (locale IN ('zh-Hans', 'ja', 'en'));

INSERT INTO notification.templates(type, locale, version, title_template, body_template, active)
VALUES
  ('registration.changed','zh-Hans',1,'报名状态已更新','{{eventTitle}}：当前状态为 {{status}}。',true),
  ('registration.changed','ja',1,'参加状況が更新されました','{{eventTitle}}：現在の状況は {{status}} です。',true),
  ('registration.changed','en',1,'Registration updated','{{eventTitle}} is now {{status}}.',true),
  ('waitlist.offered','zh-Hans',1,'候补名额已为你保留','{{eventTitle}} 有空位，请在 {{expiresAt}} 前确认。',true),
  ('waitlist.offered','ja',1,'キャンセル待ち枠をご用意しました','{{eventTitle}} の枠を {{expiresAt}} まで確保しています。',true),
  ('waitlist.offered','en',1,'A waitlist spot is ready','Confirm your spot for {{eventTitle}} by {{expiresAt}}.',true),
  ('event.cancelled','zh-Hans',1,'活动已取消','{{eventTitle}} 已取消，Spott 报名积分将按规则退回。',true),
  ('event.cancelled','ja',1,'イベントは中止されました','{{eventTitle}} は中止されました。Spottポイントは規定に従い返還されます。',true),
  ('event.cancelled','en',1,'Event cancelled','{{eventTitle}} was cancelled. Eligible Spott points will be returned.',true),
  ('event.key_fields_changed','zh-Hans',1,'活动重要信息有变更','请确认 {{eventTitle}} 的时间、地点或费用变更。',true),
  ('event.key_fields_changed','ja',1,'イベントの重要情報が変更されました','{{eventTitle}} の日時・場所・料金の変更をご確認ください。',true),
  ('event.key_fields_changed','en',1,'Important event details changed','Review the time, place, or fee changes for {{eventTitle}}.',true),
  ('group.announcement','zh-Hans',1,'{{groupName}} 发布了新公告','{{announcementTitle}}',true),
  ('group.announcement','ja',1,'{{groupName}} から新しいお知らせ','{{announcementTitle}}',true),
  ('group.announcement','en',1,'New announcement from {{groupName}}','{{announcementTitle}}',true),
  ('points.changed','zh-Hans',1,'积分已更新','本次变动 {{delta}}，当前总积分 {{balance}}。',true),
  ('points.changed','ja',1,'ポイントが更新されました','今回の変動は {{delta}}、現在の合計は {{balance}} です。',true),
  ('points.changed','en',1,'Points updated','Change: {{delta}}. Current total: {{balance}}.',true)
ON CONFLICT (type, locale, version) DO NOTHING;

COMMIT;
