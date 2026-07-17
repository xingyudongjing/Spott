import { describe, expect, it } from 'vitest';
import { containsBannedContent, findBannedTerm, normalizeForModeration } from '../src/index.js';

describe('controlled-messaging offensive filter', () => {
  const banned = ['去死', 'idiot', '傻逼'];

  it('passes clean text through', () => {
    expect(containsBannedContent('周末一起去代代木公园散步吗？', banned)).toBe(false);
    expect(findBannedTerm('周末一起去代代木公园散步吗？', banned)).toBeNull();
  });

  it('flags a configured banned term regardless of surrounding text', () => {
    expect(containsBannedContent('你这个idiot别来了', banned)).toBe(true);
    expect(findBannedTerm('你这个idiot别来了', banned)).toBe('idiot');
  });

  it('defeats separator and full-width evasion', () => {
    expect(containsBannedContent('傻 逼', banned)).toBe(true);
    expect(containsBannedContent('ＩＤＩＯＴ', banned)).toBe(true);
    expect(containsBannedContent('i.d.i.o.t', banned)).toBe(true);
  });

  it('ignores empty entries so a misconfigured list never blocks everything', () => {
    expect(containsBannedContent('完全正常的一句话', ['', '   '])).toBe(false);
  });

  it('normalizes to a lowercase, separator-free comparison form', () => {
    expect(normalizeForModeration('Ｈｅ ｌ-l_o')).toBe('hello');
  });
});
