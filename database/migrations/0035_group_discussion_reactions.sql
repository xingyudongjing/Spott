-- Group discussion board: post/reply likes and a reply-listing index.
--
-- The discussion board itself reuses community.comments with target_type = 'group'
-- for member-authored top-level posts (parent_id IS NULL) and their replies
-- (parent_id -> the post). Those columns already exist, so no new content table is
-- needed. This migration adds only what the board cannot express today:
--
--   1. community.comment_reactions — per-user "like" on a discussion post or reply.
--      Modelled exactly like community.announcement_reactions (composite PK, ON
--      DELETE CASCADE, reaction pinned to 'like') so the two surfaces behave the
--      same. Likes are engagement signals only; they never touch points, so this
--      stays clear of the "no platform-money" product boundary.
--   2. ix_comments_parent — supports listing a post's replies in order without
--      scanning every group comment. The existing ix_comments_target_created only
--      covers the (target_type, target_id) top-level listing.
BEGIN;

CREATE TABLE IF NOT EXISTS community.comment_reactions (
  comment_id uuid NOT NULL REFERENCES community.comments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  reaction text NOT NULL DEFAULT 'like' CHECK (reaction = 'like'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (comment_id, user_id)
);

COMMENT ON TABLE community.comment_reactions IS
  'Per-user like on a community.comments row (group discussion posts and replies). Engagement only; never linked to points or money.';

CREATE INDEX IF NOT EXISTS ix_comment_reactions_user
  ON community.comment_reactions(user_id);

CREATE INDEX IF NOT EXISTS ix_comments_parent
  ON community.comments(parent_id, created_at, id)
  WHERE parent_id IS NOT NULL AND deleted_at IS NULL AND status = 'visible';

COMMIT;
