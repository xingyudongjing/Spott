-- Synthetic public-preview data only. No administrator, session, wallet, points,
-- phone, email, device, registration, or real-person records are created.
BEGIN;

SELECT pg_advisory_xact_lock(86720260717001);

INSERT INTO identity.users(id, public_handle)
VALUES
  ('019f1000-0000-7000-8000-000000000001', 'spott_preview_studio'),
  ('019f1000-0000-7000-8000-000000000002', 'spott_preview_weekend')
ON CONFLICT (id) DO NOTHING;

INSERT INTO identity.profiles AS preview_profile(user_id, nickname, bio, region_id, source_language)
VALUES
  (
    '019f1000-0000-7000-8000-000000000001',
    '东京余光散步会',
    '每月选一条适合慢走的东京路线，用手机或相机记录日常光线。第一次参加也没关系。',
    'tokyo',
    'zh-Hans'
  ),
  (
    '019f1000-0000-7000-8000-000000000002',
    'Shimokita Listening Table',
    '下北沢の小さなテーブルで、一枚のレコードを最後まで聴く夜をひらいています。',
    'tokyo',
    'ja'
  )
ON CONFLICT (user_id) DO UPDATE SET
  nickname = EXCLUDED.nickname,
  bio = EXCLUDED.bio,
  region_id = EXCLUDED.region_id,
  source_language = EXCLUDED.source_language
WHERE preview_profile.user_id IN (
  '019f1000-0000-7000-8000-000000000001',
  '019f1000-0000-7000-8000-000000000002'
)
  AND md5(preview_profile.bio) IN (
    '17ea8073f9b1bd38729981b9d7d5933f',
    'c2bd141bd8ae0cfae72ea62fdfad3fc9'
  );

INSERT INTO community.groups AS preview_group(
  id, owner_id, name, slug, description, join_mode, capacity, status,
  region_id, category_id, tags, rules
)
VALUES
  (
    '019f1000-0000-7000-8200-000000000001',
    '019f1000-0000-7000-8000-000000000001',
    '东京慢走与光线观察',
    'tokyo-light-walks',
    '不赶景点，也不比设备。每月选一段适合慢走的东京街区，边走边观察光线、建筑和日常生活。',
    'open', 100, 'active', 'tokyo', 'city-walk',
    ARRAY['城市散步', '摄影', '新手友好']::text[],
    '尊重同行者与街区居民；拍摄清晰可辨的人像前请先征得同意；活动中不推销课程或器材。'
  ),
  (
    '019f1000-0000-7000-8200-000000000002',
    '019f1000-0000-7000-8000-000000000002',
    '下北沢一枚聴く会',
    'shimokita-one-record',
    '一度に数曲だけを、最後までゆっくり聴く会です。下北沢の小さなテーブルで、選んだ理由や最近見つけた音楽を持ち寄ります。',
    'approval', 100, 'active', 'tokyo', 'music',
    ARRAY['音楽', 'レコード', '少人数']::text[],
    '音楽の知識は問いません。録音・配信・営業目的の参加はご遠慮ください。盤と互いの好みを丁寧に扱いましょう。'
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO community.group_memberships AS preview_membership(
  id, group_id, user_id, role, status
)
VALUES
  (
    '019f1000-0000-7000-8210-000000000001',
    '019f1000-0000-7000-8200-000000000001',
    '019f1000-0000-7000-8000-000000000001',
    'owner', 'active'
  ),
  (
    '019f1000-0000-7000-8210-000000000002',
    '019f1000-0000-7000-8200-000000000001',
    '019f1000-0000-7000-8000-000000000002',
    'member', 'active'
  ),
  (
    '019f1000-0000-7000-8210-000000000003',
    '019f1000-0000-7000-8200-000000000002',
    '019f1000-0000-7000-8000-000000000002',
    'owner', 'active'
  ),
  (
    '019f1000-0000-7000-8210-000000000004',
    '019f1000-0000-7000-8200-000000000002',
    '019f1000-0000-7000-8000-000000000001',
    'member', 'active'
  )
ON CONFLICT (group_id, user_id) DO NOTHING;

INSERT INTO community.announcements AS preview_announcement(
  id, group_id, author_id, title, body, visibility, comments_enabled, pinned_at
)
VALUES
  (
    '019f1000-0000-7000-8220-000000000001',
    '019f1000-0000-7000-8200-000000000001',
    '019f1000-0000-7000-8000-000000000001',
    '第一次同行前，可以先知道这些',
    '路线通常是 3–5 公里，中间会停下来观察和交流。手机就够用，也可以完全不拍照。集合点与天气调整会在活动页更新。',
    'public', true, clock_timestamp()
  ),
  (
    '019f1000-0000-7000-8220-000000000002',
    '019f1000-0000-7000-8200-000000000002',
    '019f1000-0000-7000-8000-000000000002',
    '今月のテーマ：一曲目',
    'アルバムの一曲目だけを持ち寄る回です。手ぶらの方には主催者の候補から選んでもらいます。好きな理由を一言話せれば十分です。',
    'public', true, clock_timestamp()
  )
ON CONFLICT (id) DO NOTHING;

WITH preview_clock AS (
  SELECT date_trunc('hour', clock_timestamp()) AS now_at
)
INSERT INTO events.events AS preview_event(
  id, public_slug, organizer_id, group_id, status, title, description, category_id,
  starts_at, ends_at, deadline_at, capacity, tags, attendee_requirements,
  primary_locale, supported_locales, locale_confirmed_at, created_by, updated_by
)
SELECT
  event.id::uuid,
  event.public_slug,
  event.organizer_id::uuid,
  event.group_id::uuid,
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
    '019f1000-0000-7000-8200-000000000001',
    '东京余光 · 隅田川蓝调散步',
    '日落前在清澄白河集合，沿小名木川走向隅田川。途中会有三次短暂停留，大家交换取景想法，最后在河岸分享当天最喜欢的一张照片。',
    'city-walk', interval '8 days', interval '8 days 2 hours 30 minutes',
    interval '7 days', 24, ARRAY['摄影', '城市散步', '初次友好']::text[],
    '全程约 4 公里，请穿适合步行的鞋并自备饮水。手机或相机都可以；中文主持，也可用日语和英语交流。',
    'zh-Hans', ARRAY['zh-Hans', 'ja', 'en']::text[]
  ),
  (
    '019f1000-0000-7000-8100-000000000002',
    'shimokita-vinyl-preview',
    '019f1000-0000-7000-8000-000000000002',
    '019f1000-0000-7000-8200-000000000002',
    '下北沢 Listening Table · 一枚を聴く夜',
    '好きなレコードを一枚持ち寄り、片面から一曲ずつ聴きます。音楽の知識は不要。選んだ理由や下北沢でよく行く店を、少人数のテーブルでゆっくり話しましょう。',
    'music', interval '45 days 9 hours', interval '45 days 12 hours',
    interval '44 days', 18, ARRAY['音楽', 'レコード', '少人数']::text[],
    '交換会ではなく試聴会です。高価な盤や代替できないコレクションはお持ちにならないでください。手ぶら参加も歓迎します。',
    'ja', ARRAY['ja', 'en', 'zh-Hans']::text[]
  ),
  (
    '019f1000-0000-7000-8100-000000000003',
    'kamakura-morning-preview',
    '019f1000-0000-7000-8000-000000000001',
    NULL,
    'Kamakura Morning Reset · Coastline Walk & Coffee',
    'Meet by the coast before the crowds arrive. We will start with a short safety check and warm-up, walk at an easy pace, then trade local breakfast tips over coffee near the station.',
    'outdoor', interval '90 days', interval '90 days 3 hours',
    interval '88 days', 12, ARRAY['coast', 'morning', 'easy pace']::text[],
    'Bring water, sun protection and shoes suitable for sand. Guests under 18 must join with a guardian. We postpone in unsafe weather.',
    'en', ARRAY['en', 'ja', 'zh-Hans']::text[]
  )
) AS event(
  id, public_slug, organizer_id, group_id, title, description, category_id,
  start_offset, end_offset, deadline_offset, capacity, tags, attendee_requirements,
  primary_locale, supported_locales
)
ON CONFLICT (id) DO UPDATE SET
  group_id = EXCLUDED.group_id,
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  category_id = EXCLUDED.category_id,
  tags = EXCLUDED.tags,
  attendee_requirements = EXCLUDED.attendee_requirements,
  primary_locale = EXCLUDED.primary_locale,
  supported_locales = EXCLUDED.supported_locales,
  locale_confirmed_at = EXCLUDED.locale_confirmed_at,
  updated_by = EXCLUDED.updated_by,
  updated_at = clock_timestamp()
WHERE preview_event.organizer_id = EXCLUDED.organizer_id
  AND preview_event.id IN (
    '019f1000-0000-7000-8100-000000000001',
    '019f1000-0000-7000-8100-000000000002',
    '019f1000-0000-7000-8100-000000000003'
  )
  AND md5(preview_event.description) IN (
    '1f09af547bdbe0825f1853d5f1b5f779',
    '985f3922472fcf0eacb309e56b975dec',
    '8360cb83f3127f12afa16d0b5106b07a'
  );

INSERT INTO events.event_capacity AS preview_capacity(event_id, confirmed_count, pending_count, waitlist_count, offered_count)
VALUES
  ('019f1000-0000-7000-8100-000000000001', 11, 0, 0, 0),
  ('019f1000-0000-7000-8100-000000000002', 7, 0, 0, 0),
  ('019f1000-0000-7000-8100-000000000003', 9, 0, 0, 0)
ON CONFLICT (event_id) DO NOTHING;

INSERT INTO events.event_locations AS preview_location(
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

INSERT INTO events.event_fees AS preview_fee(
  event_id, is_free, amount_jpy, collector_name, method, payment_deadline_text, refund_policy
)
VALUES
  ('019f1000-0000-7000-8100-000000000001', true, NULL, NULL, NULL, NULL, NULL),
  ('019f1000-0000-7000-8100-000000000002', true, NULL, NULL, NULL, NULL, NULL),
  (
    '019f1000-0000-7000-8100-000000000003', false, 3800,
    'Kamakura Morning Club', 'Contactless payment at the venue', '48 hours before the event',
    'Cancel with the host at least 48 hours before the event for a full refund.'
  )
ON CONFLICT (event_id) DO UPDATE SET
  is_free = EXCLUDED.is_free,
  amount_jpy = EXCLUDED.amount_jpy,
  collector_name = EXCLUDED.collector_name,
  method = EXCLUDED.method,
  payment_deadline_text = EXCLUDED.payment_deadline_text,
  refund_policy = EXCLUDED.refund_policy,
  updated_at = clock_timestamp()
WHERE preview_fee.event_id IN (
  '019f1000-0000-7000-8100-000000000001',
  '019f1000-0000-7000-8100-000000000002',
  '019f1000-0000-7000-8100-000000000003'
)
  AND md5(COALESCE(preview_fee.collector_name, '')) = '8fb3066a29e4fdfaf677541a53b05e22'
  AND EXISTS (
    SELECT 1
    FROM events.events AS owning_preview_event
    WHERE owning_preview_event.id = preview_fee.event_id
      AND owning_preview_event.organizer_id IN (
        '019f1000-0000-7000-8000-000000000001',
        '019f1000-0000-7000-8000-000000000002'
      )
  );

COMMIT;
