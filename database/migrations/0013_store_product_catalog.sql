-- StoreKit consumables are server-configured so iOS never hard-codes point values.
-- Promotional points remain a free/expiring ledger bucket separate from paid points.
BEGIN;

ALTER TABLE commerce.store_orders
  ADD COLUMN IF NOT EXISTS bonus_points_transaction_id uuid
    REFERENCES commerce.point_transactions(id);

INSERT INTO commerce.store_products(
  store, product_id, points, bonus_points, active_from, active_until
) VALUES
  ('apple', 'jp.spott.points.500',   500,    0, '2026-07-15 00:00:00+09', NULL),
  ('apple', 'jp.spott.points.1000', 1000,   50, '2026-07-15 00:00:00+09', NULL),
  ('apple', 'jp.spott.points.3000', 3000,  300, '2026-07-15 00:00:00+09', NULL),
  ('apple', 'jp.spott.points.5000', 5000,  750, '2026-07-15 00:00:00+09', NULL),
  ('apple', 'jp.spott.points.10000',10000,2000, '2026-07-15 00:00:00+09', NULL)
ON CONFLICT (store, product_id) DO UPDATE SET
  points = EXCLUDED.points,
  bonus_points = EXCLUDED.bonus_points,
  active_from = LEAST(commerce.store_products.active_from, EXCLUDED.active_from),
  active_until = NULL;

COMMIT;
