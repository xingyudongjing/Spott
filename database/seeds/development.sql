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
