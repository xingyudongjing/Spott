-- Add structured discovery attributes without treating migration defaults as organizer-confirmed locales.
BEGIN;

CREATE OR REPLACE FUNCTION events.valid_event_locales(locales text[], primary_locale text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT cardinality(locales) BETWEEN 1 AND 3
    AND locales <@ ARRAY['zh-Hans', 'ja', 'en']::text[]
    AND primary_locale = ANY(locales)
    AND cardinality(locales) = (
      SELECT count(DISTINCT supported.locale)
      FROM unnest(locales) AS supported(locale)
    );
$$;

ALTER TABLE events.events
  ADD COLUMN format text NOT NULL DEFAULT 'in_person',
  ADD COLUMN primary_locale text NOT NULL DEFAULT 'ja',
  ADD COLUMN supported_locales text[] NOT NULL DEFAULT ARRAY['ja']::text[],
  ADD COLUMN locale_confirmed_at timestamptz;

ALTER TABLE events.events
  ADD CONSTRAINT events_format_check
    CHECK (format IN ('in_person', 'online', 'hybrid')),
  ADD CONSTRAINT events_primary_locale_check
    CHECK (primary_locale IN ('zh-Hans', 'ja', 'en')),
  ADD CONSTRAINT events_supported_locales_check
    CHECK (events.valid_event_locales(supported_locales, primary_locale));

CREATE INDEX events_discovery_locale_idx
  ON events.events(primary_locale, starts_at, id)
  WHERE deleted_at IS NULL AND locale_confirmed_at IS NOT NULL;

COMMIT;
