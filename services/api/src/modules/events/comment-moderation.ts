/**
 * Controlled-comment content screening (product G3 / M1「需过滤攻击性内容」).
 *
 * The blocklist itself is backend-configurable (admin.config_revisions key
 * `community.comment.blocklist`); this module only implements the matching so
 * the rule set never has to be hardcoded at a call site.
 */

/** Fallback blocklist used only until an operator publishes a config revision. */
export const DEFAULT_COMMENT_BLOCKLIST: readonly string[] = [
  'fuck',
  'shit',
  'bitch',
  'asshole',
  'retard',
  '傻逼',
  '沙比',
  '去死',
  '滚蛋',
  '婊子',
  '死全家',
  'くたばれ',
  '死ね',
];

export interface CommentScreeningResult {
  clean: boolean;
  matched: string[];
}

/**
 * Normalises the body (case-folded, NFKC) and reports every blocklist term it
 * contains. A non-empty `matched` list means the comment must be rejected.
 */
export function screenCommentBody(body: string, blocklist: readonly string[]): CommentScreeningResult {
  const normalized = body.normalize('NFKC').toLowerCase();
  const matched: string[] = [];
  for (const rawTerm of blocklist) {
    const term = rawTerm.normalize('NFKC').toLowerCase().trim();
    if (term.length > 0 && normalized.includes(term)) {
      matched.push(rawTerm);
    }
  }
  return { clean: matched.length === 0, matched };
}
