-- Synthetic public-preview data only. No administrator, session, wallet, points,
-- phone, email, device, registration, or real-person records are created.
BEGIN;

SELECT pg_advisory_xact_lock(86720260717001);

INSERT INTO identity.users(id, public_handle)
VALUES
  ('019f1000-0000-7000-8000-000000000001', 'spott_preview_studio'),
  ('019f1000-0000-7000-8000-000000000002', 'spott_preview_weekend')
ON CONFLICT (id) DO NOTHING;

INSERT INTO identity.profiles(user_id, nickname, bio, region_id, source_language)
VALUES
  (
    '019f1000-0000-7000-8000-000000000001',
    'Spott 城市企划室',
    '用于公网只读预览的合成主办方，不对应任何真实个人。',
    'tokyo',
    'zh-Hans'
  ),
  (
    '019f1000-0000-7000-8000-000000000002',
    'Weekend Lab',
    'Synthetic preview organizer / プレビュー専用の架空主催者。',
    'tokyo',
    'en'
  )
ON CONFLICT (user_id) DO NOTHING;

WITH preview_clock AS (
  SELECT date_trunc('hour', clock_timestamp()) AS now_at
)
INSERT INTO events.events(
  id, public_slug, organizer_id, status, title, description, category_id,
  starts_at, ends_at, deadline_at, capacity, tags, attendee_requirements,
  primary_locale, supported_locales, locale_confirmed_at, created_by, updated_by
)
SELECT
  event.id::uuid,
  event.public_slug,
  event.organizer_id::uuid,
  'published'::events.event_status,
  event.title,
  event.description,
  event.category_id,
  preview_clock.now_at + event.start_offset,
  preview_clock.now_at + event.end_offset,
  preview_clock.now_at + event.deadline_offset,
  event.capacity,
  event.tags,
  event.attendee_requirements,
  event.primary_locale,
  event.supported_locales,
  preview_clock.now_at,
  event.organizer_id::uuid,
  event.organizer_id::uuid
FROM preview_clock
CROSS JOIN (VALUES
  (
    '019f1000-0000-7000-8100-000000000001',
    'tokyo-afterglow-preview',
    '019f1000-0000-7000-8000-000000000001',
    '东京余光 · 隅田川蓝调散步',
    '在日落前后穿过清澄白河与隅田川，以小组方式记录城市光线。此为合成预览活动。',
    'city-walk', interval '8 days', interval '8 days 2 hours 30 minutes',
    interval '7 days', 24, ARRAY['摄影', '城市散步', '初次友好']::text[],
    '请穿适合步行的鞋，活动语言支持中文、日本語与 English。',
    'zh-Hans', ARRAY['zh-Hans', 'ja', 'en']::text[]
  ),
  (
    '019f1000-0000-7000-8100-000000000002',
    'shimokita-vinyl-preview',
    '019f1000-0000-7000-8000-000000000002',
    '下北沢 Vinyl Salon · 黑胶交换夜',
    'Bring one record you love. 好きな一枚を囲み、少人数で音楽と街の話をします。',
    'music', interval '45 days 9 hours', interval '45 days 12 hours',
    interval '44 days', 18, ARRAY['音乐', '交流', '室内']::text[],
    '无需专业知识；请勿携带贵重或无法替换的收藏品。',
    'ja', ARRAY['ja', 'en', 'zh-Hans']::text[]
  ),
  (
    '019f1000-0000-7000-8100-000000000003',
    'kamakura-morning-preview',
    '019f1000-0000-7000-8000-000000000001',
    '鎌倉 Morning Reset · 海岸晨间体验',
    'A calm early-morning coastal session with a safety briefing, warm-up and café debrief.',
    'outdoor', interval '90 days', interval '90 days 3 hours',
    interval '88 days', 12, ARRAY['户外', '晨间', '镰仓']::text[],
    '未成年人需由监护人陪同；恶劣天气时将改期。',
    'en', ARRAY['en', 'ja', 'zh-Hans']::text[]
  )
) AS event(
  id, public_slug, organizer_id, title, description, category_id,
  start_offset, end_offset, deadline_offset, capacity, tags, attendee_requirements,
  primary_locale, supported_locales
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO events.event_capacity(event_id, confirmed_count, pending_count, waitlist_count, offered_count)
VALUES
  ('019f1000-0000-7000-8100-000000000001', 11, 0, 0, 0),
  ('019f1000-0000-7000-8100-000000000002', 7, 0, 0, 0),
  ('019f1000-0000-7000-8100-000000000003', 9, 0, 0, 0)
ON CONFLICT (event_id) DO NOTHING;

INSERT INTO events.event_locations(
  event_id, region_id, public_area, exact_address_cipher, point, visibility,
  exact_address_visibility
)
VALUES
  (
    '019f1000-0000-7000-8100-000000000001', 'tokyo', '清澄白河站附近', NULL,
    ST_GeogFromText('POINT(139.7997 35.6826)'), 'public', 'confirmed'
  ),
  (
    '019f1000-0000-7000-8100-000000000002', 'tokyo', '下北沢', NULL,
    ST_GeogFromText('POINT(139.6675 35.6616)'), 'public', 'confirmed'
  ),
  (
    '019f1000-0000-7000-8100-000000000003', 'kanagawa', '鎌倉海岸', NULL,
    ST_GeogFromText('POINT(139.5358 35.3023)'), 'public', 'confirmed'
  )
ON CONFLICT (event_id) DO NOTHING;

INSERT INTO events.event_fees(
  event_id, is_free, amount_jpy, collector_name, method, payment_deadline_text, refund_policy
)
VALUES
  ('019f1000-0000-7000-8100-000000000001', true, NULL, NULL, NULL, NULL, NULL),
  ('019f1000-0000-7000-8100-000000000002', true, NULL, NULL, NULL, NULL, NULL),
  (
    '019f1000-0000-7000-8100-000000000003', false, 3800,
    'Spott Preview Studio', '现场电子支付', '活动开始前 48 小时',
    '活动开始 48 小时前可联系主办方取消；此内容仅用于界面预览。'
  )
ON CONFLICT (event_id) DO NOTHING;

COMMIT;
