-- Host → attendee broadcast. Notification templates for the
-- `event.host_announcement` type so the in-app inbox, push and e-mail channels
-- render the organizer's message with a localized frame. Fan-out itself reuses
-- the existing notification.notifications inbox (no new table): each row carries
-- the announcement in payload_ref and deep-links back to the event.
BEGIN;

INSERT INTO notification.templates(type, locale, version, title_template, body_template, active)
VALUES
  ('event.host_announcement','zh-Hans',1,'{{eventTitle}} · 主办方通知','{{announcementTitle}}',true),
  ('event.host_announcement','ja',1,'{{eventTitle}} · 主催者からのお知らせ','{{announcementTitle}}',true),
  ('event.host_announcement','en',1,'{{eventTitle}} · Message from the host','{{announcementTitle}}',true)
ON CONFLICT (type, locale, version) DO NOTHING;

COMMIT;
