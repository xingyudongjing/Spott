-- Synthetic development data only. Never copy production personal data to non-production.
BEGIN;

INSERT INTO identity.users(id, public_handle, phone_verified_at)
VALUES
  ('019b0000-0000-7000-8000-000000000001', 'tokyo_hikari', clock_timestamp()),
  ('019b0000-0000-7000-8000-000000000002', 'weekend_kai', clock_timestamp()),
  ('019b0000-0000-7000-8000-000000000003', 'demo_guest', NULL),
  ('019b0000-0000-7000-8000-000000000004', 'spott_ops', clock_timestamp()),
  ('019b0000-0000-7000-8000-000000000005', 'spott_ops_reviewer', clock_timestamp())
ON CONFLICT (id) DO NOTHING;

INSERT INTO identity.profiles(user_id, nickname, bio, region_id)
VALUES
  ('019b0000-0000-7000-8000-000000000001', '小光', '东京散步、摄影和咖啡。', 'tokyo'),
  ('019b0000-0000-7000-8000-000000000002', '周末开局', '一起发现城市的另一面。', 'tokyo'),
  ('019b0000-0000-7000-8000-000000000003', '体验用户', '', 'tokyo'),
  ('019b0000-0000-7000-8000-000000000004', 'Spott 运营', '', 'tokyo'),
  ('019b0000-0000-7000-8000-000000000005', 'Spott 复核员', '', 'tokyo')
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO identity.devices(id, user_id, platform)
VALUES
  ('019b0000-0000-7000-8001-000000000001', '019b0000-0000-7000-8000-000000000001', 'ios'),
  ('019b0000-0000-7000-8001-000000000002', '019b0000-0000-7000-8000-000000000002', 'web')
ON CONFLICT (id) DO NOTHING;

INSERT INTO events.events(
  id, public_slug, organizer_id, status, title, description, category_id,
  starts_at, ends_at, deadline_at, capacity, created_by, updated_by
) VALUES
  (
    '019b0000-0000-7000-8100-000000000001', 'tokyo-afterglow-walk',
    '019b0000-0000-7000-8000-000000000002', 'published',
    '东京余光 · 隅田川蓝调散步',
    '从清澄白河走到隅田川，在入夜前后记录城市颜色。适合第一次参加的朋友。',
    'city-walk', '2026-07-18T08:30:00Z', '2026-07-18T11:00:00Z',
    '2026-07-18T03:00:00Z', 24,
    '019b0000-0000-7000-8000-000000000002', '019b0000-0000-7000-8000-000000000002'
  ),
  (
    '019b0000-0000-7000-8100-000000000002', 'shimokita-vinyl-night',
    '019b0000-0000-7000-8000-000000000001', 'published',
    '下北泽黑胶交换夜',
    '带一张最近循环播放的唱片，认识同样认真听歌的人。',
    'music', '2026-07-20T10:00:00Z', '2026-07-20T13:00:00Z',
    '2026-07-20T04:00:00Z', 16,
    '019b0000-0000-7000-8000-000000000001', '019b0000-0000-7000-8000-000000000001'
  ),
  (
    '019b0000-0000-7000-8100-000000000003', 'kamakura-morning-surf',
    '019b0000-0000-7000-8000-000000000002', 'published',
    '镰仓晨光冲浪体验',
    '零基础小班，装备由外部教练提供。费用由组织者自行收取。',
    'outdoor', '2026-07-25T21:00:00Z', '2026-07-26T00:00:00Z',
    '2026-07-24T15:00:00Z', 10,
    '019b0000-0000-7000-8000-000000000002', '019b0000-0000-7000-8000-000000000002'
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO events.event_capacity(event_id, confirmed_count)
VALUES
  ('019b0000-0000-7000-8100-000000000001', 11),
  ('019b0000-0000-7000-8100-000000000002', 8),
  ('019b0000-0000-7000-8100-000000000003', 9)
ON CONFLICT (event_id) DO NOTHING;

INSERT INTO events.event_locations(event_id, region_id, public_area, exact_address_cipher, point)
VALUES
  ('019b0000-0000-7000-8100-000000000001', 'tokyo', '清澄白河站附近', decode('64656d6f', 'hex'), ST_GeogFromText('POINT(139.7997 35.6826)')),
  ('019b0000-0000-7000-8100-000000000002', 'tokyo', '下北泽', decode('64656d6f', 'hex'), ST_GeogFromText('POINT(139.6675 35.6616)')),
  ('019b0000-0000-7000-8100-000000000003', 'kanagawa', '镰仓海岸', decode('64656d6f', 'hex'), ST_GeogFromText('POINT(139.5358 35.3023)'))
ON CONFLICT (event_id) DO NOTHING;

INSERT INTO events.event_fees(event_id, is_free, amount_jpy, collector_name, method, refund_policy)
VALUES
  ('019b0000-0000-7000-8100-000000000001', true, NULL, NULL, NULL, NULL),
  ('019b0000-0000-7000-8100-000000000002', true, NULL, NULL, NULL, NULL),
  ('019b0000-0000-7000-8100-000000000003', false, 4500, 'Wave Studio', '现场 PayPay', '活动开始 48 小时前可联系组织者退款')
ON CONFLICT (event_id) DO NOTHING;

INSERT INTO commerce.wallets(user_id, paid_balance, free_balance)
VALUES
  ('019b0000-0000-7000-8000-000000000001', 300, 520),
  ('019b0000-0000-7000-8000-000000000002', 0, 900),
  ('019b0000-0000-7000-8000-000000000003', 0, 0)
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO commerce.point_transactions(id, user_id, type, business_key, status, posted_at)
VALUES
  ('019b0000-0000-7000-8300-000000000001', '019b0000-0000-7000-8000-000000000001', 'development_seed', 'seed:hikari', 'posted', clock_timestamp()),
  ('019b0000-0000-7000-8300-000000000002', '019b0000-0000-7000-8000-000000000002', 'development_seed', 'seed:host', 'posted', clock_timestamp())
ON CONFLICT (id) DO NOTHING;

INSERT INTO commerce.point_entries(id, transaction_id, account_code, bucket, amount, expires_at)
VALUES
  ('019b0000-0000-7000-8310-000000000001', '019b0000-0000-7000-8300-000000000001', 'user:019b0000-0000-7000-8000-000000000001', 'paid', 300, NULL),
  ('019b0000-0000-7000-8310-000000000002', '019b0000-0000-7000-8300-000000000001', 'platform:seed', 'paid', -300, NULL),
  ('019b0000-0000-7000-8310-000000000003', '019b0000-0000-7000-8300-000000000001', 'user:019b0000-0000-7000-8000-000000000001', 'free', 520, clock_timestamp() + interval '365 days'),
  ('019b0000-0000-7000-8310-000000000004', '019b0000-0000-7000-8300-000000000001', 'platform:seed', 'free', -520, NULL),
  ('019b0000-0000-7000-8310-000000000005', '019b0000-0000-7000-8300-000000000002', 'user:019b0000-0000-7000-8000-000000000002', 'free', 900, clock_timestamp() + interval '365 days'),
  ('019b0000-0000-7000-8310-000000000006', '019b0000-0000-7000-8300-000000000002', 'platform:seed', 'free', -900, NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO admin.admin_users(id, identity_user_id, roles, data_scopes, mfa_enrolled_at)
VALUES
  (
    '019b0000-0000-7000-8200-000000000001',
    '019b0000-0000-7000-8000-000000000004',
    ARRAY[
      'moderator','support','securityLead','eventReviewer','groupReviewer',
      'pointsRequester','pointsApprover','financeRead','financeLead',
      'configEditor','configApprover','analyst','auditReader'
    ], ARRAY['jp'], clock_timestamp()
  ),
  (
    '019b0000-0000-7000-8200-000000000002',
    '019b0000-0000-7000-8000-000000000005',
    ARRAY[
      'moderator','support','securityLead','eventReviewer','groupReviewer',
      'pointsRequester','pointsApprover','financeRead','financeLead',
      'configEditor','configApprover','analyst','auditReader'
    ], ARRAY['jp'], clock_timestamp()
  )
ON CONFLICT (id) DO UPDATE SET
  roles = EXCLUDED.roles,
  data_scopes = EXCLUDED.data_scopes,
  disabled_at = NULL;

INSERT INTO admin.config_revisions(
  key, value_json, version, state, submitted_by, approved_by, effective_from
) VALUES
  ('points.reward.phone_verified', '500', 1, 'active', '019b0000-0000-7000-8200-000000000001', NULL, clock_timestamp()),
  ('points.reward.profile_completed', '100', 1, 'active', '019b0000-0000-7000-8200-000000000001', NULL, clock_timestamp()),
  ('points.cost.registration', '10', 1, 'active', '019b0000-0000-7000-8200-000000000001', NULL, clock_timestamp()),
  ('points.cost.event_publish', '100', 1, 'active', '019b0000-0000-7000-8200-000000000001', NULL, clock_timestamp()),
  ('event.max_capacity.default', '500', 1, 'active', '019b0000-0000-7000-8200-000000000001', NULL, clock_timestamp()),
  ('registration.cancel_refund_hours', '24', 1, 'active', '019b0000-0000-7000-8200-000000000001', NULL, clock_timestamp()),
  ('checkin.window.before_minutes', '60', 1, 'active', '019b0000-0000-7000-8200-000000000001', NULL, clock_timestamp()),
  ('checkin.window.after_minutes', '120', 1, 'active', '019b0000-0000-7000-8200-000000000001', NULL, clock_timestamp()),
  ('group.initial_capacity', '50', 1, 'active', '019b0000-0000-7000-8200-000000000001', NULL, clock_timestamp()),
  ('group.capacity_increment', '50', 1, 'active', '019b0000-0000-7000-8200-000000000001', NULL, clock_timestamp()),
  ('sync.change_retention_days', '90', 1, 'active', '019b0000-0000-7000-8200-000000000001', NULL, clock_timestamp())
ON CONFLICT (key, version) DO NOTHING;

COMMIT;

-- ============================================================================
-- Rich development dataset (2026-07): ~24 published events across all nine
-- categories and four regions, covers via media assets, active promotions,
-- groups with members/announcements/discussion, and confirmed registrations.
-- Additive only: nothing above this line is modified, and every statement is
-- idempotent (fixed UUIDs + ON CONFLICT). Event dates are computed relative to
-- the moment the seed runs so the home feed always looks alive.
-- ============================================================================
BEGIN;

-- JST-relative helpers (session-scoped, recreated on every run).
CREATE OR REPLACE FUNCTION pg_temp.seed_jst(day_offset int, hour int, minute int DEFAULT 0)
RETURNS timestamptz LANGUAGE sql STABLE AS $seed_helper$
  SELECT (date_trunc('day', clock_timestamp() AT TIME ZONE 'Asia/Tokyo')
          + make_interval(days => day_offset, hours => hour, mins => minute)) AT TIME ZONE 'Asia/Tokyo'
$seed_helper$;

-- Days until the coming Saturday in JST (0 when today is Saturday).
CREATE OR REPLACE FUNCTION pg_temp.seed_sat()
RETURNS int LANGUAGE sql STABLE AS $seed_helper$
  SELECT ((6 - EXTRACT(dow FROM clock_timestamp() AT TIME ZONE 'Asia/Tokyo')::int + 7) % 7)
$seed_helper$;

-- ---------------------------------------------------------------------------
-- Additional members and organizers
-- ---------------------------------------------------------------------------
INSERT INTO identity.users(id, public_handle, phone_verified_at)
VALUES
  ('019b0000-0000-7000-8000-000000000011', 'morning_runner_ken', clock_timestamp()),
  ('019b0000-0000-7000-8000-000000000012', 'coffee_maki', clock_timestamp()),
  ('019b0000-0000-7000-8000-000000000013', 'kansai_foodie', clock_timestamp()),
  ('019b0000-0000-7000-8000-000000000014', 'kyoto_walker', clock_timestamp()),
  ('019b0000-0000-7000-8000-000000000015', 'shonan_rider', clock_timestamp()),
  ('019b0000-0000-7000-8000-000000000016', 'tokyo_mira', clock_timestamp()),
  ('019b0000-0000-7000-8000-000000000017', 'sakura_lens', clock_timestamp()),
  ('019b0000-0000-7000-8000-000000000018', 'board_game_taro', clock_timestamp()),
  ('019b0000-0000-7000-8000-000000000019', 'study_hana', clock_timestamp()),
  ('019b0000-0000-7000-8000-00000000001a', 'nomad_ken', clock_timestamp())
ON CONFLICT (id) DO NOTHING;

INSERT INTO identity.profiles(user_id, nickname, bio, region_id)
VALUES
  ('019b0000-0000-7000-8000-000000000011', '晨跑阿健', '代代木公园晨跑俱乐部主理人，风雨无阻第三年。', 'tokyo'),
  ('019b0000-0000-7000-8000-000000000012', '手冲玛琪', '咖啡师，收集全东京的浅烘豆。', 'tokyo'),
  ('019b0000-0000-7000-8000-000000000013', '关西吃货团长', '大阪土著，胃是导航。', 'osaka'),
  ('019b0000-0000-7000-8000-000000000014', '京都慢步', '住在京都的路线设计师，寺庙比朋友熟。', 'kyoto'),
  ('019b0000-0000-7000-8000-000000000015', '湘南骑士', '海边长大，SUP 和冲浪教练。', 'kanagawa'),
  ('019b0000-0000-7000-8000-000000000016', '未来酱', '什么都想试一试的新东京人。', 'tokyo'),
  ('019b0000-0000-7000-8000-000000000017', '樱花镜头', '摄影是借口，散步是目的。', 'tokyo'),
  ('019b0000-0000-7000-8000-000000000018', '桌游太郎', '家里堆了两百盒桌游，缺人开。', 'tokyo'),
  ('019b0000-0000-7000-8000-000000000019', '自习花花', '读书会和英语角常客。', 'tokyo'),
  ('019b0000-0000-7000-8000-00000000001a', '数字游民Ken', '一年换四个城市办公。', 'tokyo')
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO commerce.wallets(user_id, paid_balance, free_balance)
VALUES
  ('019b0000-0000-7000-8000-000000000011', 2000, 800),
  ('019b0000-0000-7000-8000-000000000012', 2000, 800),
  ('019b0000-0000-7000-8000-000000000013', 2000, 800),
  ('019b0000-0000-7000-8000-000000000014', 2000, 800),
  ('019b0000-0000-7000-8000-000000000015', 2000, 800),
  ('019b0000-0000-7000-8000-000000000016', 0, 500),
  ('019b0000-0000-7000-8000-000000000017', 0, 500),
  ('019b0000-0000-7000-8000-000000000018', 2000, 800),
  ('019b0000-0000-7000-8000-000000000019', 0, 500),
  ('019b0000-0000-7000-8000-00000000001a', 2000, 800)
ON CONFLICT (user_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Group cover assets (state ready + approved so /v1/groups serves cover_url)
-- ---------------------------------------------------------------------------
INSERT INTO media.assets(
  id, current_owner_id, created_owner_id, purpose, mime_type, byte_size,
  state, moderation_state, scan_state, derivatives, uploaded_at, ready_at,
  legacy_preallocated_object_key
)
SELECT ('019b0000-0000-7000-8420-' || cover.suffix)::uuid,
  cover.owner::uuid, cover.owner::uuid, 'group_cover', 'image/jpeg', 512000,
  'ready', 'approved', 'clean',
  jsonb_build_object(
    'thumb', jsonb_build_object('url', 'https://picsum.photos/seed/spott-group-' || cover.slug || '/600/400'),
    'card',  jsonb_build_object('url', 'https://picsum.photos/seed/spott-group-' || cover.slug || '/1200/800'),
    'hero',  jsonb_build_object('url', 'https://picsum.photos/seed/spott-group-' || cover.slug || '/1600/900')
  ),
  clock_timestamp(), clock_timestamp(), 'seed/group-covers/' || cover.slug || '.jpg'
FROM (VALUES
  ('000000000001', '019b0000-0000-7000-8000-000000000011', 'yoyogi-run-club'),
  ('000000000002', '019b0000-0000-7000-8000-000000000012', 'tokyo-coffee-hoppers'),
  ('000000000003', '019b0000-0000-7000-8000-000000000013', 'kansai-weekend-eats'),
  ('000000000004', '019b0000-0000-7000-8000-000000000014', 'kyoto-culture-walks'),
  ('000000000005', '019b0000-0000-7000-8000-000000000015', 'shonan-outdoor-club'),
  ('000000000006', '019b0000-0000-7000-8000-000000000018', 'tokyo-boardgame-guild')
) AS cover(suffix, owner, slug)
ON CONFLICT (id) DO UPDATE SET derivatives = EXCLUDED.derivatives, updated_at = clock_timestamp();

-- ---------------------------------------------------------------------------
-- Groups, memberships, announcements, discussion posts
-- ---------------------------------------------------------------------------
INSERT INTO community.groups(
  id, owner_id, name, slug, description, join_mode, capacity,
  region_id, category_id, tags, rules, cover_asset_id
) VALUES
  (
    '019b0000-0000-7000-8600-000000000001', '019b0000-0000-7000-8000-000000000011',
    '代代木晨跑俱乐部', 'yoyogi-run-club',
    '每周六早上在代代木公园集合晨跑，慢速组和配速组都有，跑完一起吃早餐，新人友好。',
    'open', 50, 'tokyo', 'sports', ARRAY['晨跑','运动','免费'],
    '准时集合，量力而跑，恶劣天气提前一晚群里通知。',
    '019b0000-0000-7000-8420-000000000001'
  ),
  (
    '019b0000-0000-7000-8600-000000000002', '019b0000-0000-7000-8000-000000000012',
    '东京咖啡漫游', 'tokyo-coffee-hoppers',
    '一群认真喝咖啡的人，每月两次探店和手冲会，分享豆单和冲煮参数，欢迎入坑。',
    'open', 50, 'tokyo', 'food', ARRAY['咖啡','探店'],
    '不催单、不占座太久，探店消费各自结账。',
    '019b0000-0000-7000-8420-000000000002'
  ),
  (
    '019b0000-0000-7000-8600-000000000003', '019b0000-0000-7000-8000-000000000013',
    '关西周末食堂', 'kansai-weekend-eats',
    '大阪京都神户轮流吃，从街边小吃到老铺洋食，拒绝踩雷，人均预算提前公布。',
    'approval', 50, 'osaka', 'food', ARRAY['美食','大阪','关西'],
    '报名后请务必出席，鸽两次会被移出群组。',
    '019b0000-0000-7000-8420-000000000003'
  ),
  (
    '019b0000-0000-7000-8600-000000000004', '019b0000-0000-7000-8000-000000000014',
    '京都文化散步会', 'kyoto-culture-walks',
    '寺庙、町家、庭园与美术馆，每次一条主题路线，走得慢，讲得细，拍照自由。',
    'open', 50, 'kyoto', 'art', ARRAY['京都','文化','散步'],
    '寺庙内请保持安静，遵守各处拍照规定。',
    '019b0000-0000-7000-8420-000000000004'
  ),
  (
    '019b0000-0000-7000-8600-000000000005', '019b0000-0000-7000-8000-000000000015',
    '湘南户外部', 'shonan-outdoor-club',
    '以江之岛为据点，SUP、冲浪、徒步和露营轮着来，装备可以借，教练很耐心。',
    'open', 50, 'kanagawa', 'outdoor', ARRAY['户外','湘南','海边'],
    '水上项目必须穿救生衣，听从教练安排。',
    '019b0000-0000-7000-8420-000000000005'
  ),
  (
    '019b0000-0000-7000-8600-000000000006', '019b0000-0000-7000-8000-000000000018',
    '东京桌游公会', 'tokyo-boardgame-guild',
    '每周四固定桌游夜，德式美式都玩，新手桌有人带，偶尔通宵狼人杀，自带零食。',
    'open', 50, 'tokyo', 'games', ARRAY['桌游','聚会'],
    '爱惜配件，输了不许掀桌。',
    '019b0000-0000-7000-8420-000000000006'
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO community.group_memberships(id, group_id, user_id, role, status)
VALUES
  ('019b0000-0000-7000-8610-000000000001', '019b0000-0000-7000-8600-000000000001', '019b0000-0000-7000-8000-000000000011', 'owner', 'active'),
  ('019b0000-0000-7000-8610-000000000002', '019b0000-0000-7000-8600-000000000001', '019b0000-0000-7000-8000-000000000016', 'member', 'active'),
  ('019b0000-0000-7000-8610-000000000003', '019b0000-0000-7000-8600-000000000001', '019b0000-0000-7000-8000-000000000017', 'member', 'active'),
  ('019b0000-0000-7000-8610-000000000004', '019b0000-0000-7000-8600-000000000001', '019b0000-0000-7000-8000-000000000019', 'member', 'active'),
  ('019b0000-0000-7000-8610-000000000005', '019b0000-0000-7000-8600-000000000001', '019b0000-0000-7000-8000-000000000001', 'member', 'active'),
  ('019b0000-0000-7000-8610-000000000006', '019b0000-0000-7000-8600-000000000002', '019b0000-0000-7000-8000-000000000012', 'owner', 'active'),
  ('019b0000-0000-7000-8610-000000000007', '019b0000-0000-7000-8600-000000000002', '019b0000-0000-7000-8000-000000000018', 'member', 'active'),
  ('019b0000-0000-7000-8610-000000000008', '019b0000-0000-7000-8600-000000000002', '019b0000-0000-7000-8000-00000000001a', 'member', 'active'),
  ('019b0000-0000-7000-8610-000000000009', '019b0000-0000-7000-8600-000000000002', '019b0000-0000-7000-8000-000000000002', 'member', 'active'),
  ('019b0000-0000-7000-8610-00000000000a', '019b0000-0000-7000-8600-000000000003', '019b0000-0000-7000-8000-000000000013', 'owner', 'active'),
  ('019b0000-0000-7000-8610-00000000000b', '019b0000-0000-7000-8600-000000000003', '019b0000-0000-7000-8000-000000000016', 'member', 'active'),
  ('019b0000-0000-7000-8610-00000000000c', '019b0000-0000-7000-8600-000000000003', '019b0000-0000-7000-8000-000000000018', 'member', 'active'),
  ('019b0000-0000-7000-8610-00000000000d', '019b0000-0000-7000-8600-000000000004', '019b0000-0000-7000-8000-000000000014', 'owner', 'active'),
  ('019b0000-0000-7000-8610-00000000000e', '019b0000-0000-7000-8600-000000000004', '019b0000-0000-7000-8000-000000000017', 'member', 'active'),
  ('019b0000-0000-7000-8610-00000000000f', '019b0000-0000-7000-8600-000000000004', '019b0000-0000-7000-8000-000000000019', 'member', 'active'),
  ('019b0000-0000-7000-8610-000000000010', '019b0000-0000-7000-8600-000000000005', '019b0000-0000-7000-8000-000000000015', 'owner', 'active'),
  ('019b0000-0000-7000-8610-000000000011', '019b0000-0000-7000-8600-000000000005', '019b0000-0000-7000-8000-000000000016', 'member', 'active'),
  ('019b0000-0000-7000-8610-000000000012', '019b0000-0000-7000-8600-000000000005', '019b0000-0000-7000-8000-00000000001a', 'member', 'active'),
  ('019b0000-0000-7000-8610-000000000013', '019b0000-0000-7000-8600-000000000006', '019b0000-0000-7000-8000-000000000018', 'owner', 'active'),
  ('019b0000-0000-7000-8610-000000000014', '019b0000-0000-7000-8600-000000000006', '019b0000-0000-7000-8000-000000000016', 'member', 'active'),
  ('019b0000-0000-7000-8610-000000000015', '019b0000-0000-7000-8600-000000000006', '019b0000-0000-7000-8000-000000000019', 'member', 'active'),
  ('019b0000-0000-7000-8610-000000000016', '019b0000-0000-7000-8600-000000000006', '019b0000-0000-7000-8000-000000000003', 'member', 'active')
ON CONFLICT DO NOTHING;

INSERT INTO community.announcements(id, group_id, author_id, title, body, visibility, comments_enabled, pinned_at)
VALUES
  ('019b0000-0000-7000-8620-000000000001', '019b0000-0000-7000-8600-000000000001', '019b0000-0000-7000-8000-000000000011',
   '本周晨跑安排', '本周六照常 7:00 原宿门集合，慢速组 5km、配速组 10km。跑完去参宫桥的面包店吃早餐，新朋友直接来就行。', 'public', true, clock_timestamp()),
  ('019b0000-0000-7000-8620-000000000002', '019b0000-0000-7000-8600-000000000001', '019b0000-0000-7000-8000-000000000011',
   '新人须知', '第一次来的朋友：穿舒服的跑鞋即可，公园里有储物柜和自动贩卖机，跑前热身十分钟一起做。', 'members', true, NULL),
  ('019b0000-0000-7000-8620-000000000003', '019b0000-0000-7000-8600-000000000002', '019b0000-0000-7000-8000-000000000012',
   '八月咖啡地图投票', '八月探店候选：清澄白河两家新店、藏前的自家烘焙所，群里投票选两家，票高者进下月路线。', 'public', true, NULL),
  ('019b0000-0000-7000-8620-000000000004', '019b0000-0000-7000-8600-000000000005', '019b0000-0000-7000-8000-000000000015',
   '江之岛SUP装备清单', '周末 SUP 请带泳衣、毛巾、防晒和一瓶水，板和救生衣俱乐部提供，近视的朋友建议戴眼镜绑带。', 'public', true, NULL),
  ('019b0000-0000-7000-8620-000000000005', '019b0000-0000-7000-8600-000000000006', '019b0000-0000-7000-8000-000000000018',
   '每周桌游夜改到周四', '从下周起固定改为周四晚上，场地不变，19:00 开门，21:30 之后到的只能加入狼人杀。', 'members', true, NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO community.comments(id, target_type, target_id, author_id, body, parent_id)
VALUES
  ('019b0000-0000-7000-8630-000000000001', 'group', '019b0000-0000-7000-8600-000000000001', '019b0000-0000-7000-8000-000000000016',
   '今天第一次参加晨跑，配速很友好，下次继续！', NULL),
  ('019b0000-0000-7000-8630-000000000002', 'group', '019b0000-0000-7000-8600-000000000001', '019b0000-0000-7000-8000-000000000017',
   '欢迎常来，周六还有慢速组～', '019b0000-0000-7000-8630-000000000001'),
  ('019b0000-0000-7000-8630-000000000003', 'group', '019b0000-0000-7000-8600-000000000001', '019b0000-0000-7000-8000-000000000019',
   '有人周日想加练 10km 吗？', NULL),
  ('019b0000-0000-7000-8630-000000000004', 'group', '019b0000-0000-7000-8600-000000000002', '019b0000-0000-7000-8000-00000000001a',
   '中目黑那家新店的浅烘豆子真的惊艳。', NULL),
  ('019b0000-0000-7000-8630-000000000005', 'group', '019b0000-0000-7000-8600-000000000002', '019b0000-0000-7000-8000-000000000012',
   '下次手冲会就安排它！', '019b0000-0000-7000-8630-000000000004'),
  ('019b0000-0000-7000-8630-000000000006', 'group', '019b0000-0000-7000-8600-000000000006', '019b0000-0000-7000-8000-000000000016',
   '求带《卡坦岛》，我们三缺一。', NULL),
  ('019b0000-0000-7000-8630-000000000007', 'group', '019b0000-0000-7000-8600-000000000006', '019b0000-0000-7000-8000-000000000018',
   '我有一盒，周四带过去。', '019b0000-0000-7000-8630-000000000006'),
  ('019b0000-0000-7000-8630-000000000008', 'group', '019b0000-0000-7000-8600-000000000005', '019b0000-0000-7000-8000-000000000016',
   '第一次玩 SUP 需要会游泳吗？', NULL),
  ('019b0000-0000-7000-8630-000000000009', 'group', '019b0000-0000-7000-8600-000000000005', '019b0000-0000-7000-8000-000000000015',
   '会漂就行，全程穿救生衣，教练全程跟。', '019b0000-0000-7000-8630-000000000008')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 24 upcoming published events across all nine categories and four regions.
-- Dates are relative to seeding time; re-running refreshes the schedule.
-- ---------------------------------------------------------------------------
INSERT INTO events.events(
  id, public_slug, organizer_id, status, title, description, category_id, tags,
  starts_at, ends_at, deadline_at, capacity, created_by, updated_by, group_id
) VALUES
  -- Today
  (
    '019b0000-0000-7000-8100-000000000010', 'nakameguro-pourover-lab',
    '019b0000-0000-7000-8000-000000000012', 'published',
    '中目黑咖啡手冲工作坊',
    '精品咖啡店包场，四款单品豆轮流冲，从磨豆到注水手把手教。名额很少，想学手冲的别犹豫。',
    'food', ARRAY['咖啡','手冲','小班'],
    clock_timestamp() + interval '3 hours', clock_timestamp() + interval '5 hours',
    clock_timestamp() + interval '2 hours', 8,
    '019b0000-0000-7000-8000-000000000012', '019b0000-0000-7000-8000-000000000012',
    '019b0000-0000-7000-8600-000000000002'
  ),
  (
    '019b0000-0000-7000-8100-000000000011', 'yurakucho-board-game-night',
    '019b0000-0000-7000-8000-000000000018', 'published',
    '有乐町桌游之夜',
    '下班后来玩两局！狼人杀、卡坦岛、Splendor 任选，新手桌有人带，可以中途加入。',
    'games', ARRAY['桌游','下班后'],
    clock_timestamp() + interval '5 hours', clock_timestamp() + interval '9 hours',
    clock_timestamp() + interval '4 hours', 20,
    '019b0000-0000-7000-8000-000000000018', '019b0000-0000-7000-8000-000000000018',
    '019b0000-0000-7000-8600-000000000006'
  ),
  -- Tomorrow
  (
    '019b0000-0000-7000-8100-000000000012', 'yoyogi-morning-run',
    '019b0000-0000-7000-8000-000000000011', 'published',
    '代代木公园晨跑俱乐部',
    '每周固定晨跑，5km 慢速组和 10km 配速组任选，跑完一起吃早餐。风雨无阻，新人友好。',
    'sports', ARRAY['晨跑','免费','新人友好'],
    pg_temp.seed_jst(1, 7, 0), pg_temp.seed_jst(1, 9, 0), pg_temp.seed_jst(1, 6, 0), 30,
    '019b0000-0000-7000-8000-000000000011', '019b0000-0000-7000-8000-000000000011',
    '019b0000-0000-7000-8600-000000000001'
  ),
  (
    '019b0000-0000-7000-8100-000000000013', 'kagurazaka-stone-walk',
    '019b0000-0000-7000-8000-000000000001', 'published',
    '神乐坂石板路漫步',
    '从饭田桥沿石板坡道慢慢走到赤城神社，路过好几家昭和老铺，边走边聊，拍照自由。',
    'city-walk', ARRAY['散步','摄影'],
    pg_temp.seed_jst(1, 18, 30), pg_temp.seed_jst(1, 20, 30), pg_temp.seed_jst(1, 17, 0), 15,
    '019b0000-0000-7000-8000-000000000001', '019b0000-0000-7000-8000-000000000001', NULL
  ),
  -- Coming weekend
  (
    '019b0000-0000-7000-8100-000000000014', 'showa-kinen-family-picnic',
    '019b0000-0000-7000-8000-000000000002', 'published',
    '昭和纪念公园亲子野餐日',
    '大草坪自由活动加亲子定向小游戏，自带野餐垫和便当，孩子们一起放风筝。',
    'family', ARRAY['亲子','野餐','公园'],
    pg_temp.seed_jst(pg_temp.seed_sat(), 10, 0), pg_temp.seed_jst(pg_temp.seed_sat(), 14, 0),
    pg_temp.seed_jst(pg_temp.seed_sat(), 8, 0), 40,
    '019b0000-0000-7000-8000-000000000002', '019b0000-0000-7000-8000-000000000002', NULL
  ),
  (
    '019b0000-0000-7000-8100-000000000015', 'enoshima-sunset-sup',
    '019b0000-0000-7000-8000-000000000015', 'published',
    '江之岛落日SUP体验',
    '零基础可参加，教练带队看着夕阳划回岸边。含板和救生衣，费用由俱乐部现场收取。',
    'outdoor', ARRAY['SUP','海边','夕阳'],
    pg_temp.seed_jst(pg_temp.seed_sat(), 16, 0), pg_temp.seed_jst(pg_temp.seed_sat(), 18, 30),
    pg_temp.seed_jst(pg_temp.seed_sat() - 1, 20, 0), 12,
    '019b0000-0000-7000-8000-000000000015', '019b0000-0000-7000-8000-000000000015',
    '019b0000-0000-7000-8600-000000000005'
  ),
  (
    '019b0000-0000-7000-8100-000000000016', 'kyoto-kamogawa-sketch',
    '019b0000-0000-7000-8000-000000000014', 'published',
    '鸭川写生下午茶',
    '在鸭川三角洲找个位置坐下，画什么都行，画完互相围观，顺便喝一杯附近的咖啡。',
    'art', ARRAY['写生','京都'],
    pg_temp.seed_jst(pg_temp.seed_sat() + 1, 14, 0), pg_temp.seed_jst(pg_temp.seed_sat() + 1, 17, 0),
    pg_temp.seed_jst(pg_temp.seed_sat() + 1, 12, 0), 16,
    '019b0000-0000-7000-8000-000000000014', '019b0000-0000-7000-8000-000000000014',
    '019b0000-0000-7000-8600-000000000004'
  ),
  (
    '019b0000-0000-7000-8100-000000000017', 'osaka-dotonbori-food-crawl',
    '019b0000-0000-7000-8000-000000000013', 'published',
    '大阪道顿堀小吃暴走团',
    '两小时吃遍道顿堀：章鱼烧、串炸、蟹肉包子一路扫过去，人均预算 3000 日元，现场 AA。',
    'food', ARRAY['小吃','大阪','暴走'],
    pg_temp.seed_jst(pg_temp.seed_sat(), 17, 0), pg_temp.seed_jst(pg_temp.seed_sat(), 19, 30),
    pg_temp.seed_jst(pg_temp.seed_sat(), 12, 0), 18,
    '019b0000-0000-7000-8000-000000000013', '019b0000-0000-7000-8000-000000000013',
    '019b0000-0000-7000-8600-000000000003'
  ),
  (
    '019b0000-0000-7000-8100-000000000018', 'tama-river-bbq',
    '019b0000-0000-7000-8000-000000000002', 'published',
    '多摩川河畔烧烤会',
    '场地和炭火已订好，食材统一采购，你人来就行。会烤肉的自动升级为主厨。',
    'outdoor', ARRAY['烧烤','河边'],
    pg_temp.seed_jst(pg_temp.seed_sat() + 1, 11, 0), pg_temp.seed_jst(pg_temp.seed_sat() + 1, 15, 0),
    pg_temp.seed_jst(pg_temp.seed_sat(), 20, 0), 35,
    '019b0000-0000-7000-8000-000000000002', '019b0000-0000-7000-8000-000000000002', NULL
  ),
  -- Next week
  (
    '019b0000-0000-7000-8100-000000000019', 'shinjuku-gyoen-english-picnic',
    '019b0000-0000-7000-8000-000000000019', 'published',
    '新宿御苑英语角野餐',
    '中英混聊，主题卡片破冰，晒着太阳练口语，比教室里自然多了。门票自理。',
    'learning', ARRAY['英语角','野餐'],
    pg_temp.seed_jst(3, 11, 0), pg_temp.seed_jst(3, 14, 0), pg_temp.seed_jst(3, 9, 0), 25,
    '019b0000-0000-7000-8000-000000000019', '019b0000-0000-7000-8000-000000000019', NULL
  ),
  (
    '019b0000-0000-7000-8100-00000000001a', 'akihabara-switch-meetup',
    '019b0000-0000-7000-8000-000000000018', 'published',
    '秋叶原Switch面基局',
    '马车 8、大乱斗、Splatoon 车轮战，带上你的 Switch 和 Joy-Con，输的请饮料。',
    'games', ARRAY['Switch','游戏'],
    pg_temp.seed_jst(4, 19, 0), pg_temp.seed_jst(4, 22, 0), pg_temp.seed_jst(4, 17, 0), 16,
    '019b0000-0000-7000-8000-000000000018', '019b0000-0000-7000-8000-000000000018',
    '019b0000-0000-7000-8600-000000000006'
  ),
  (
    '019b0000-0000-7000-8100-00000000001b', 'yokohama-minatomirai-nightride',
    '019b0000-0000-7000-8000-000000000011', 'published',
    '横滨港未来夜骑',
    '沿海边骑行 15km，红砖仓库打卡合影，速度很佛系，有租车点可以现场租。',
    'sports', ARRAY['骑行','夜景'],
    pg_temp.seed_jst(4, 19, 30), pg_temp.seed_jst(4, 21, 30), pg_temp.seed_jst(4, 17, 0), 20,
    '019b0000-0000-7000-8000-000000000011', '019b0000-0000-7000-8000-000000000011', NULL
  ),
  (
    '019b0000-0000-7000-8100-00000000001c', 'kyoto-machiya-tea-ceremony',
    '019b0000-0000-7000-8000-000000000014', 'published',
    '京都町家茶道体验',
    '百年町家里的一席茶，老师用中文讲解点茶流程，含和菓子一份。着装随意，跪坐可换椅子。',
    'art', ARRAY['茶道','町家','京都'],
    pg_temp.seed_jst(5, 13, 0), pg_temp.seed_jst(5, 15, 0), pg_temp.seed_jst(4, 20, 0), 10,
    '019b0000-0000-7000-8000-000000000014', '019b0000-0000-7000-8000-000000000014',
    '019b0000-0000-7000-8600-000000000004'
  ),
  (
    '019b0000-0000-7000-8100-00000000001d', 'umeda-product-night',
    '019b0000-0000-7000-8000-000000000013', 'published',
    '梅田产品人交流夜',
    '关西做产品和设计的朋友聚一聚，两个闪电分享加自由交流，带名片或不带都行。',
    'networking', ARRAY['产品','交流','关西'],
    pg_temp.seed_jst(5, 19, 0), pg_temp.seed_jst(5, 21, 30), pg_temp.seed_jst(5, 12, 0), 30,
    '019b0000-0000-7000-8000-000000000013', '019b0000-0000-7000-8000-000000000013', NULL
  ),
  (
    '019b0000-0000-7000-8100-00000000001e', 'daikanyama-bookclub',
    '019b0000-0000-7000-8000-000000000019', 'published',
    '代官山读书会：《人类简史》',
    '提前读完前六章，现场按问题卡讨论，不用发表高见，听着也很有收获。',
    'learning', ARRAY['读书会','代官山'],
    pg_temp.seed_jst(6, 14, 0), pg_temp.seed_jst(6, 16, 30), pg_temp.seed_jst(6, 10, 0), 12,
    '019b0000-0000-7000-8000-000000000019', '019b0000-0000-7000-8000-000000000019', NULL
  ),
  (
    '019b0000-0000-7000-8100-00000000001f', 'odaiba-family-science-day',
    '019b0000-0000-7000-8000-000000000012', 'published',
    '台场亲子科学实验日',
    '干冰泡泡、非牛顿流体、纸桥承重挑战，适合 5-10 岁小朋友，家长一起动手。',
    'family', ARRAY['亲子','科学','实验'],
    pg_temp.seed_jst(6, 10, 30), pg_temp.seed_jst(6, 12, 30), pg_temp.seed_jst(5, 20, 0), 24,
    '019b0000-0000-7000-8000-000000000012', '019b0000-0000-7000-8000-000000000012', NULL
  ),
  (
    '019b0000-0000-7000-8100-000000000020', 'shibuya-startup-pitch-night',
    '019b0000-0000-7000-8000-00000000001a', 'published',
    '涩谷创业路演之夜',
    '六组早期项目各 5 分钟路演，台下有投资人和工程师，路演后自由交流，气氛热烈。',
    'networking', ARRAY['创业','路演','涩谷'],
    pg_temp.seed_jst(7, 19, 0), pg_temp.seed_jst(7, 22, 0), pg_temp.seed_jst(7, 12, 0), 60,
    '019b0000-0000-7000-8000-00000000001a', '019b0000-0000-7000-8000-00000000001a', NULL
  ),
  -- Week 2-3
  (
    '019b0000-0000-7000-8100-000000000021', 'hakone-old-road-onsen-hike',
    '019b0000-0000-7000-8000-000000000015', 'published',
    '箱根旧街道温泉徒步',
    '沿江户旧街道石畳走到芦之湖，约 8km，下山直接泡日归温泉。徒步免费，温泉自理。',
    'outdoor', ARRAY['徒步','温泉','箱根'],
    pg_temp.seed_jst(8, 9, 0), pg_temp.seed_jst(8, 15, 0), pg_temp.seed_jst(7, 20, 0), 14,
    '019b0000-0000-7000-8000-000000000015', '019b0000-0000-7000-8000-000000000015',
    '019b0000-0000-7000-8600-000000000005'
  ),
  (
    '019b0000-0000-7000-8100-000000000022', 'tsukiji-sushi-morning-tour',
    '019b0000-0000-7000-8000-000000000012', 'published',
    '筑地市场寿司晨游',
    '七点半集合逛场外市场，向导带你吃玉子烧和现开海胆，最后一起吃立食寿司早餐。',
    'food', ARRAY['寿司','市场','早餐'],
    pg_temp.seed_jst(9, 7, 30), pg_temp.seed_jst(9, 10, 0), pg_temp.seed_jst(8, 20, 0), 8,
    '019b0000-0000-7000-8000-000000000012', '019b0000-0000-7000-8000-000000000012', NULL
  ),
  (
    '019b0000-0000-7000-8100-000000000023', 'arashiyama-family-cycling',
    '019b0000-0000-7000-8000-000000000014', 'published',
    '岚山亲子骑行半日游',
    '沿桂川骑到竹林小径，全程平路，提供儿童座椅和小车，骑累了在河边吃刨冰。',
    'family', ARRAY['亲子','骑行','岚山'],
    pg_temp.seed_jst(10, 9, 30), pg_temp.seed_jst(10, 12, 30), pg_temp.seed_jst(9, 20, 0), 20,
    '019b0000-0000-7000-8000-000000000014', '019b0000-0000-7000-8000-000000000014', NULL
  ),
  (
    '019b0000-0000-7000-8100-000000000024', 'osaka-castle-night-run',
    '019b0000-0000-7000-8000-000000000013', 'published',
    '大阪城公园夜跑团',
    '绕大阪城公园一圈 4.6km，跑两圈或走一圈都行，结束后天守阁夜景合影。',
    'sports', ARRAY['夜跑','大阪'],
    pg_temp.seed_jst(11, 19, 30), pg_temp.seed_jst(11, 21, 0), pg_temp.seed_jst(11, 17, 0), 40,
    '019b0000-0000-7000-8000-000000000013', '019b0000-0000-7000-8000-000000000013', NULL
  ),
  (
    '019b0000-0000-7000-8100-000000000025', 'nakano-broadway-anime-walk',
    '019b0000-0000-7000-8000-000000000017', 'published',
    '中野百老汇动漫寻宝',
    '老牌动漫圣地两小时深度逛，骨灰级店铺路线图已画好，预算管不住是唯一风险。',
    'city-walk', ARRAY['动漫','中野','扫街'],
    pg_temp.seed_jst(13, 13, 0), pg_temp.seed_jst(13, 15, 30), pg_temp.seed_jst(13, 10, 0), 15,
    '019b0000-0000-7000-8000-000000000017', '019b0000-0000-7000-8000-000000000017', NULL
  ),
  (
    '019b0000-0000-7000-8100-000000000026', 'ginza-watercolor-class',
    '019b0000-0000-7000-8000-000000000016', 'published',
    '银座水彩入门课',
    '从调色开始，两小时完成一幅街景小品，画具全部提供，零基础完全 OK。',
    'art', ARRAY['水彩','入门'],
    pg_temp.seed_jst(15, 10, 0), pg_temp.seed_jst(15, 12, 0), pg_temp.seed_jst(14, 20, 0), 12,
    '019b0000-0000-7000-8000-000000000016', '019b0000-0000-7000-8000-000000000016', NULL
  ),
  (
    '019b0000-0000-7000-8100-000000000027', 'kawasaki-factory-night-photo',
    '019b0000-0000-7000-8000-000000000017', 'published',
    '川崎工厂夜景摄影团',
    '拍京滨工业区的赛博朋克夜景，三脚架必备，老法师带机位，拍完互评照片。',
    'city-walk', ARRAY['摄影','夜景','工业风'],
    pg_temp.seed_jst(17, 18, 30), pg_temp.seed_jst(17, 21, 0), pg_temp.seed_jst(17, 12, 0), 10,
    '019b0000-0000-7000-8000-000000000017', '019b0000-0000-7000-8000-000000000017', NULL
  )
ON CONFLICT (id) DO UPDATE SET
  starts_at = EXCLUDED.starts_at,
  ends_at = EXCLUDED.ends_at,
  deadline_at = EXCLUDED.deadline_at,
  updated_at = clock_timestamp();

-- Three completed past runs so 晨跑阿健 qualifies as a verified host
-- (phone verified + >=3 completed events); status 'ended' auto-sets completed_at.
INSERT INTO events.events(
  id, public_slug, organizer_id, status, title, description, category_id,
  starts_at, ends_at, capacity, created_by, updated_by, group_id
)
SELECT ('019b0000-0000-7000-8100-' || past.suffix)::uuid, past.slug,
  '019b0000-0000-7000-8000-000000000011', 'ended',
  past.title, '已圆满结束的晨跑场次（开发种子数据）。', 'sports',
  pg_temp.seed_jst(past.day_offset, 7, 0), pg_temp.seed_jst(past.day_offset, 9, 0), 30,
  '019b0000-0000-7000-8000-000000000011', '019b0000-0000-7000-8000-000000000011',
  '019b0000-0000-7000-8600-000000000001'
FROM (VALUES
  ('000000000031', 'yoyogi-morning-run-vol1', '代代木晨跑俱乐部 Vol.1', -14),
  ('000000000032', 'yoyogi-morning-run-vol2', '代代木晨跑俱乐部 Vol.2', -7),
  ('000000000033', 'yoyogi-morning-run-vol3', '代代木晨跑俱乐部 Vol.3', -3)
) AS past(suffix, slug, title, day_offset)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Locations, fees, capacity for the 24 upcoming events
-- ---------------------------------------------------------------------------
INSERT INTO events.event_locations(event_id, region_id, public_area, exact_address_cipher, point)
SELECT ('019b0000-0000-7000-8100-' || loc.suffix)::uuid, loc.region, loc.area,
  decode('64656d6f', 'hex'), ST_GeogFromText('POINT(' || loc.lng || ' ' || loc.lat || ')')
FROM (VALUES
  ('000000000010', 'tokyo',    '中目黑站附近',       '139.6987', '35.6440'),
  ('000000000011', 'tokyo',    '有乐町站前',         '139.7630', '35.6750'),
  ('000000000012', 'tokyo',    '代代木公园 原宿门',  '139.6949', '35.6712'),
  ('000000000013', 'tokyo',    '神乐坂',             '139.7400', '35.7020'),
  ('000000000014', 'tokyo',    '昭和纪念公园（立川）','139.3955', '35.7050'),
  ('000000000015', 'kanagawa', '江之岛海岸',         '139.4808', '35.2990'),
  ('000000000016', 'kyoto',    '鸭川三角洲',         '135.7727', '35.0300'),
  ('000000000017', 'osaka',    '道顿堀',             '135.5010', '34.6687'),
  ('000000000018', 'tokyo',    '二子玉川河川敷',     '139.6266', '35.6115'),
  ('000000000019', 'tokyo',    '新宿御苑',           '139.7100', '35.6852'),
  ('00000000001a', 'tokyo',    '秋叶原',             '139.7745', '35.6984'),
  ('00000000001b', 'kanagawa', '樱木町站集合',       '139.6317', '35.4508'),
  ('00000000001c', 'kyoto',    '二条城附近',         '135.7480', '35.0142'),
  ('00000000001d', 'osaka',    '梅田',               '135.4980', '34.7025'),
  ('00000000001e', 'tokyo',    '代官山 蔦屋书店附近','139.7030', '35.6485'),
  ('00000000001f', 'tokyo',    '台场',               '139.7770', '35.6270'),
  ('000000000020', 'tokyo',    '涩谷',               '139.7016', '35.6580'),
  ('000000000021', 'kanagawa', '箱根汤本站集合',     '139.1063', '35.2323'),
  ('000000000022', 'tokyo',    '筑地场外市场',       '139.7707', '35.6654'),
  ('000000000023', 'kyoto',    '岚山 渡月桥',        '135.6780', '35.0094'),
  ('000000000024', 'osaka',    '大阪城公园',         '135.5308', '34.6873'),
  ('000000000025', 'tokyo',    '中野百老汇',         '139.6657', '35.7074'),
  ('000000000026', 'tokyo',    '银座',               '139.7671', '35.6717'),
  ('000000000027', 'kanagawa', '川崎站东口集合',     '139.7029', '35.5308')
) AS loc(suffix, region, area, lng, lat)
ON CONFLICT (event_id) DO NOTHING;

INSERT INTO events.event_fees(event_id, is_free, amount_jpy, collector_name, method, refund_policy)
SELECT ('019b0000-0000-7000-8100-' || fee.suffix)::uuid, fee.is_free, fee.amount, fee.collector, fee.method, fee.refund
FROM (VALUES
  ('000000000010', false, 2500, 'Blue Bird Coffee', '现场 PayPay / 现金', '开始前 24 小时可全额退款'),
  ('000000000011', true,  NULL, NULL, NULL, NULL),
  ('000000000012', true,  NULL, NULL, NULL, NULL),
  ('000000000013', true,  NULL, NULL, NULL, NULL),
  ('000000000014', true,  NULL, NULL, NULL, NULL),
  ('000000000015', false, 6800, 'Shonan SUP Club', '现场 PayPay', '开始前 48 小时可联系组织者退款'),
  ('000000000016', true,  NULL, NULL, NULL, NULL),
  ('000000000017', true,  NULL, NULL, NULL, NULL),
  ('000000000018', false, 3000, '二子玉川BBQ场地', '现场现金', '开始前 24 小时可全额退款'),
  ('000000000019', true,  NULL, NULL, NULL, NULL),
  ('00000000001a', true,  NULL, NULL, NULL, NULL),
  ('00000000001b', true,  NULL, NULL, NULL, NULL),
  ('00000000001c', false, 4000, '宗和茶室', '现场现金', '开始前 72 小时可全额退款'),
  ('00000000001d', true,  NULL, NULL, NULL, NULL),
  ('00000000001e', true,  NULL, NULL, NULL, NULL),
  ('00000000001f', true,  NULL, NULL, NULL, NULL),
  ('000000000020', true,  NULL, NULL, NULL, NULL),
  ('000000000021', true,  NULL, NULL, NULL, NULL),
  ('000000000022', false, 5500, '筑地向导协会', '现场现金', '开始前 24 小时可全额退款'),
  ('000000000023', true,  NULL, NULL, NULL, NULL),
  ('000000000024', true,  NULL, NULL, NULL, NULL),
  ('000000000025', true,  NULL, NULL, NULL, NULL),
  ('000000000026', false, 3500, '彩绘工作室', '现场 PayPay', '开始前 24 小时可全额退款'),
  ('000000000027', true,  NULL, NULL, NULL, NULL)
) AS fee(suffix, is_free, amount, collector, method, refund)
ON CONFLICT (event_id) DO NOTHING;

INSERT INTO events.event_capacity(event_id, confirmed_count)
SELECT ('019b0000-0000-7000-8100-' || cap.suffix)::uuid, cap.confirmed
FROM (VALUES
  ('000000000010', 6), ('000000000011', 12), ('000000000012', 18), ('000000000013', 9),
  ('000000000014', 22), ('000000000015', 10), ('000000000016', 7), ('000000000017', 15),
  ('000000000018', 20), ('000000000019', 11), ('00000000001a', 8), ('00000000001b', 6),
  ('00000000001c', 5), ('00000000001d', 12), ('00000000001e', 6), ('00000000001f', 10),
  ('000000000020', 25), ('000000000021', 4), ('000000000022', 3), ('000000000023', 5),
  ('000000000024', 9), ('000000000025', 4), ('000000000026', 2), ('000000000027', 3)
) AS cap(suffix, confirmed)
ON CONFLICT (event_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Event cover assets: EventView.coverURL = derivatives->'card'->>'url' of the
-- sort_order-0 event_media asset. Covers the 24 new events plus the three
-- original seed events (additive; the events themselves are untouched).
-- ---------------------------------------------------------------------------
INSERT INTO media.assets(
  id, current_owner_id, created_owner_id, purpose, mime_type, byte_size,
  state, moderation_state, scan_state, derivatives, uploaded_at, ready_at,
  legacy_preallocated_object_key
)
SELECT ('019b0000-0000-7000-8400-' || cover.suffix)::uuid,
  cover.owner::uuid, cover.owner::uuid, 'event_cover', 'image/jpeg', 512000,
  'ready', 'approved', 'clean',
  jsonb_build_object(
    'thumb', jsonb_build_object('url', 'https://picsum.photos/seed/spott-' || cover.slug || '/600/400'),
    'card',  jsonb_build_object('url', 'https://picsum.photos/seed/spott-' || cover.slug || '/1200/800'),
    'hero',  jsonb_build_object('url', 'https://picsum.photos/seed/spott-' || cover.slug || '/1600/900')
  ),
  clock_timestamp(), clock_timestamp(), 'seed/event-covers/' || cover.slug || '.jpg'
FROM (VALUES
  ('000000000001', '019b0000-0000-7000-8000-000000000002', 'tokyo-afterglow-walk'),
  ('000000000002', '019b0000-0000-7000-8000-000000000001', 'shimokita-vinyl-night'),
  ('000000000003', '019b0000-0000-7000-8000-000000000002', 'kamakura-morning-surf'),
  ('000000000010', '019b0000-0000-7000-8000-000000000012', 'nakameguro-pourover-lab'),
  ('000000000011', '019b0000-0000-7000-8000-000000000018', 'yurakucho-board-game-night'),
  ('000000000012', '019b0000-0000-7000-8000-000000000011', 'yoyogi-morning-run'),
  ('000000000013', '019b0000-0000-7000-8000-000000000001', 'kagurazaka-stone-walk'),
  ('000000000014', '019b0000-0000-7000-8000-000000000002', 'showa-kinen-family-picnic'),
  ('000000000015', '019b0000-0000-7000-8000-000000000015', 'enoshima-sunset-sup'),
  ('000000000016', '019b0000-0000-7000-8000-000000000014', 'kyoto-kamogawa-sketch'),
  ('000000000017', '019b0000-0000-7000-8000-000000000013', 'osaka-dotonbori-food-crawl'),
  ('000000000018', '019b0000-0000-7000-8000-000000000002', 'tama-river-bbq'),
  ('000000000019', '019b0000-0000-7000-8000-000000000019', 'shinjuku-gyoen-english-picnic'),
  ('00000000001a', '019b0000-0000-7000-8000-000000000018', 'akihabara-switch-meetup'),
  ('00000000001b', '019b0000-0000-7000-8000-000000000011', 'yokohama-minatomirai-nightride'),
  ('00000000001c', '019b0000-0000-7000-8000-000000000014', 'kyoto-machiya-tea-ceremony'),
  ('00000000001d', '019b0000-0000-7000-8000-000000000013', 'umeda-product-night'),
  ('00000000001e', '019b0000-0000-7000-8000-000000000019', 'daikanyama-bookclub'),
  ('00000000001f', '019b0000-0000-7000-8000-000000000012', 'odaiba-family-science-day'),
  ('000000000020', '019b0000-0000-7000-8000-00000000001a', 'shibuya-startup-pitch-night'),
  ('000000000021', '019b0000-0000-7000-8000-000000000015', 'hakone-old-road-onsen-hike'),
  ('000000000022', '019b0000-0000-7000-8000-000000000012', 'tsukiji-sushi-morning-tour'),
  ('000000000023', '019b0000-0000-7000-8000-000000000014', 'arashiyama-family-cycling'),
  ('000000000024', '019b0000-0000-7000-8000-000000000013', 'osaka-castle-night-run'),
  ('000000000025', '019b0000-0000-7000-8000-000000000017', 'nakano-broadway-anime-walk'),
  ('000000000026', '019b0000-0000-7000-8000-000000000016', 'ginza-watercolor-class'),
  ('000000000027', '019b0000-0000-7000-8000-000000000017', 'kawasaki-factory-night-photo')
) AS cover(suffix, owner, slug)
ON CONFLICT (id) DO UPDATE SET derivatives = EXCLUDED.derivatives, updated_at = clock_timestamp();

-- Attach each cover at sort_order 0 (event suffix == asset suffix by design).
INSERT INTO events.event_media(id, event_id, asset_id, media_asset_id, sort_order, moderation_state)
SELECT ('019b0000-0000-7000-8410-' || m.suffix)::uuid,
  ('019b0000-0000-7000-8100-' || m.suffix)::uuid,
  ('019b0000-0000-7000-8400-' || m.suffix)::uuid,
  ('019b0000-0000-7000-8400-' || m.suffix)::uuid,
  0, 'approved'::events.review_state
FROM (VALUES
  ('000000000001'), ('000000000002'), ('000000000003'),
  ('000000000010'), ('000000000011'), ('000000000012'), ('000000000013'),
  ('000000000014'), ('000000000015'), ('000000000016'), ('000000000017'),
  ('000000000018'), ('000000000019'), ('00000000001a'), ('00000000001b'),
  ('00000000001c'), ('00000000001d'), ('00000000001e'), ('00000000001f'),
  ('000000000020'), ('000000000021'), ('000000000022'), ('000000000023'),
  ('000000000024'), ('000000000025'), ('000000000026'), ('000000000027')
) AS m(suffix)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Confirmed registrations (social proof) and past attendance for trust stats
-- ---------------------------------------------------------------------------
INSERT INTO events.registrations(id, event_id, user_id, status, party_size, source, confirmed_at)
SELECT ('019b0000-0000-7000-8700-' || reg.suffix)::uuid,
  ('019b0000-0000-7000-8100-' || reg.event_suffix)::uuid,
  reg.user_id::uuid, reg.status::events.registration_status, reg.party,
  'direct', clock_timestamp() - interval '1 day'
FROM (VALUES
  ('000000000001', '000000000012', '019b0000-0000-7000-8000-000000000016', 'confirmed', 1),
  ('000000000002', '000000000012', '019b0000-0000-7000-8000-000000000017', 'confirmed', 1),
  ('000000000003', '000000000012', '019b0000-0000-7000-8000-000000000019', 'confirmed', 2),
  ('000000000004', '000000000010', '019b0000-0000-7000-8000-000000000016', 'confirmed', 1),
  ('000000000005', '000000000010', '019b0000-0000-7000-8000-00000000001a', 'confirmed', 1),
  ('000000000006', '000000000011', '019b0000-0000-7000-8000-000000000017', 'confirmed', 1),
  ('000000000007', '000000000011', '019b0000-0000-7000-8000-000000000019', 'confirmed', 1),
  ('000000000008', '000000000014', '019b0000-0000-7000-8000-000000000016', 'confirmed', 2),
  ('000000000009', '000000000014', '019b0000-0000-7000-8000-000000000018', 'confirmed', 1),
  ('00000000000a', '000000000015', '019b0000-0000-7000-8000-000000000017', 'confirmed', 1),
  ('00000000000b', '000000000015', '019b0000-0000-7000-8000-00000000001a', 'confirmed', 1),
  ('00000000000c', '000000000017', '019b0000-0000-7000-8000-000000000016', 'confirmed', 1),
  ('00000000000d', '000000000017', '019b0000-0000-7000-8000-000000000018', 'confirmed', 2),
  ('00000000000e', '000000000020', '019b0000-0000-7000-8000-000000000019', 'confirmed', 1),
  ('00000000000f', '000000000020', '019b0000-0000-7000-8000-00000000001a', 'confirmed', 1),
  ('000000000010', '000000000020', '019b0000-0000-7000-8000-000000000017', 'confirmed', 1),
  ('000000000011', '00000000001a', '019b0000-0000-7000-8000-000000000019', 'confirmed', 1),
  -- checked-in attendance on the three completed runs (attendance-rate sample)
  ('000000000012', '000000000031', '019b0000-0000-7000-8000-000000000016', 'checked_in', 1),
  ('000000000013', '000000000031', '019b0000-0000-7000-8000-000000000017', 'checked_in', 1),
  ('000000000014', '000000000032', '019b0000-0000-7000-8000-000000000019', 'checked_in', 1),
  ('000000000015', '000000000032', '019b0000-0000-7000-8000-00000000001a', 'checked_in', 1),
  ('000000000016', '000000000033', '019b0000-0000-7000-8000-000000000016', 'checked_in', 1),
  ('000000000017', '000000000033', '019b0000-0000-7000-8000-000000000019', 'checked_in', 1)
) AS reg(suffix, event_suffix, user_id, status, party)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Active promotions (推广 badge): ledger transaction + entries + promotion.
-- Re-running the seed refreshes the promotion window so promoted:true stays on.
-- ---------------------------------------------------------------------------
INSERT INTO commerce.point_transactions(id, user_id, type, business_key, status, posted_at)
VALUES
  ('019b0000-0000-7000-8300-000000000010', '019b0000-0000-7000-8000-000000000012', 'development_seed', 'seed:boost:nakameguro-pourover-lab', 'posted', clock_timestamp()),
  ('019b0000-0000-7000-8300-000000000011', '019b0000-0000-7000-8000-000000000015', 'development_seed', 'seed:boost:enoshima-sunset-sup', 'posted', clock_timestamp()),
  ('019b0000-0000-7000-8300-000000000012', '019b0000-0000-7000-8000-000000000013', 'development_seed', 'seed:boost:osaka-dotonbori-food-crawl', 'posted', clock_timestamp()),
  ('019b0000-0000-7000-8300-000000000013', '019b0000-0000-7000-8000-00000000001a', 'development_seed', 'seed:boost:shibuya-startup-pitch-night', 'posted', clock_timestamp())
ON CONFLICT (id) DO NOTHING;

INSERT INTO commerce.point_entries(id, transaction_id, account_code, bucket, amount, expires_at)
VALUES
  ('019b0000-0000-7000-8310-000000000010', '019b0000-0000-7000-8300-000000000010', 'user:019b0000-0000-7000-8000-000000000012', 'paid', -300, NULL),
  ('019b0000-0000-7000-8310-000000000011', '019b0000-0000-7000-8300-000000000010', 'platform:promotion', 'paid', 300, NULL),
  ('019b0000-0000-7000-8310-000000000012', '019b0000-0000-7000-8300-000000000011', 'user:019b0000-0000-7000-8000-000000000015', 'paid', -1200, NULL),
  ('019b0000-0000-7000-8310-000000000013', '019b0000-0000-7000-8300-000000000011', 'platform:promotion', 'paid', 1200, NULL),
  ('019b0000-0000-7000-8310-000000000014', '019b0000-0000-7000-8300-000000000012', 'user:019b0000-0000-7000-8000-000000000013', 'paid', -600, NULL),
  ('019b0000-0000-7000-8310-000000000015', '019b0000-0000-7000-8300-000000000012', 'platform:promotion', 'paid', 600, NULL),
  ('019b0000-0000-7000-8310-000000000016', '019b0000-0000-7000-8300-000000000013', 'user:019b0000-0000-7000-8000-00000000001a', 'paid', -1200, NULL),
  ('019b0000-0000-7000-8310-000000000017', '019b0000-0000-7000-8300-000000000013', 'platform:promotion', 'paid', 1200, NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO commerce.event_promotions(
  id, event_id, organizer_id, tier, duration_hours, amount,
  purchase_transaction_id, state, starts_at, expires_at
) VALUES
  (
    '019b0000-0000-7000-8500-000000000001', '019b0000-0000-7000-8100-000000000010',
    '019b0000-0000-7000-8000-000000000012', 'boost_24h', 24, 300,
    '019b0000-0000-7000-8300-000000000010', 'active',
    clock_timestamp() - interval '1 hour', clock_timestamp() + interval '23 hours'
  ),
  (
    '019b0000-0000-7000-8500-000000000002', '019b0000-0000-7000-8100-000000000015',
    '019b0000-0000-7000-8000-000000000015', 'boost_7d', 168, 1200,
    '019b0000-0000-7000-8300-000000000011', 'active',
    clock_timestamp() - interval '1 hour', clock_timestamp() + interval '167 hours'
  ),
  (
    '019b0000-0000-7000-8500-000000000003', '019b0000-0000-7000-8100-000000000017',
    '019b0000-0000-7000-8000-000000000013', 'boost_72h', 72, 600,
    '019b0000-0000-7000-8300-000000000012', 'active',
    clock_timestamp() - interval '1 hour', clock_timestamp() + interval '71 hours'
  ),
  (
    '019b0000-0000-7000-8500-000000000004', '019b0000-0000-7000-8100-000000000020',
    '019b0000-0000-7000-8000-00000000001a', 'boost_7d', 168, 1200,
    '019b0000-0000-7000-8300-000000000013', 'active',
    clock_timestamp() - interval '1 hour', clock_timestamp() + interval '167 hours'
  )
ON CONFLICT (id) DO UPDATE SET
  state = 'active',
  starts_at = EXCLUDED.starts_at,
  expires_at = EXCLUDED.expires_at,
  updated_at = clock_timestamp();

COMMIT;
