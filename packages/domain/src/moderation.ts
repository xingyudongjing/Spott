/**
 * Offensive-content screening for controlled-messaging user text (group
 * discussion posts, replies and comments). The banned-word list is supplied by
 * the caller so operators can configure it at runtime; this module only owns the
 * normalization and matching rules so they are identical across surfaces and
 * unit-testable without a database.
 */

// Separators people insert to evade a naive filter: ASCII punctuation/whitespace
// plus the common zero-width characters (ZWSP, ZWNJ, ZWJ, BOM). Written with
// explicit escapes so the source stays free of irregular whitespace.
const SEPARATORS = /[\s.\-_*~`'"|/\\+]/g;
// Zero-width evasion characters (ZWSP, ZWNJ, ZWJ, BOM) matched via alternation
// rather than a character class to avoid misleading joined-sequence semantics.
const ZERO_WIDTH = /\u200B|\u200C|\u200D|\uFEFF/g;

/**
 * Normalize text for banned-word matching: lowercase, fold full-width ASCII to
 * half-width, and collapse the separators people insert to evade filters. The
 * result is a comparison form only; the original body is always what gets stored.
 */
export function normalizeForModeration(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(SEPARATORS, '').replace(ZERO_WIDTH, '');
}

/**
 * Returns the first configured banned word that appears in the text, or null
 * when the text is clean. Empty or whitespace-only entries in the list are
 * ignored so a misconfigured empty string never blocks every message.
 */
export function findBannedTerm(
  body: string,
  bannedWords: readonly string[],
): string | null {
  const haystack = normalizeForModeration(body);
  if (!haystack) return null;
  for (const term of bannedWords) {
    const needle = normalizeForModeration(term);
    if (needle.length === 0) continue;
    if (haystack.includes(needle)) return term;
  }
  return null;
}

/** Convenience boolean wrapper around {@link findBannedTerm}. */
export function containsBannedContent(
  body: string,
  bannedWords: readonly string[],
): boolean {
  return findBannedTerm(body, bannedWords) !== null;
}
