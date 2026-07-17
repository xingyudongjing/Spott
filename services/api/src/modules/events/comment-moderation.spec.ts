import { describe, expect, it } from 'vitest';
import { DEFAULT_COMMENT_BLOCKLIST, screenCommentBody } from './comment-moderation.js';

describe('screenCommentBody', () => {
  it('passes clean, encouraging feedback', () => {
    const result = screenCommentBody('组织得很好，下次还想参加！', DEFAULT_COMMENT_BLOCKLIST);
    expect(result.clean).toBe(true);
    expect(result.matched).toEqual([]);
  });

  it('flags an attack term regardless of surrounding text', () => {
    const result = screenCommentBody('你这个傻逼组织者', DEFAULT_COMMENT_BLOCKLIST);
    expect(result.clean).toBe(false);
    expect(result.matched).toContain('傻逼');
  });

  it('normalises case and full-width characters before matching', () => {
    const result = screenCommentBody('this is total ＳＨＩＴ', DEFAULT_COMMENT_BLOCKLIST);
    expect(result.clean).toBe(false);
    expect(result.matched).toContain('shit');
  });

  it('uses the operator-supplied blocklist rather than a hardcoded set', () => {
    const clean = screenCommentBody('spott', DEFAULT_COMMENT_BLOCKLIST);
    expect(clean.clean).toBe(true);
    const configured = screenCommentBody('spott', ['spott']);
    expect(configured.clean).toBe(false);
    expect(configured.matched).toEqual(['spott']);
  });
});
