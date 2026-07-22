import { describe, expect, test } from 'vitest';

import {
  parseAuthoritativeSessionCookieHeader,
  parseSessionCookieHeader,
} from '../app/lib/session-cookie-header';

describe('parseAuthoritativeSessionCookieHeader', () => {
  test('extracts one global completion capability and durable logout intent exactly', () => {
    expect(parseAuthoritativeSessionCookieHeader(
      'locale=ja; __Host-spott_login_intent=opaque; '
      + '__Host-spott_logout_intent=v1.7.current; __Host-spott_refresh=refresh',
    )).toEqual({
      refreshEnvelope: { kind: 'value', value: 'refresh' },
      deviceBindingEnvelope: { kind: 'absent' },
      loginIntentEnvelope: { kind: 'value', value: 'opaque' },
      logoutIntent: { kind: 'value', value: 'v1.7.current' },
    });
  });

  test.each([
    '__Host-spott_login_intent=one; __Host-spott_login_intent=two',
    '__Host-spott_login_intent=',
    '__Host-spott_login_intent',
  ])('marks a duplicate or malformed completion capability invalid: %s', (header) => {
    expect(parseAuthoritativeSessionCookieHeader(header).loginIntentEnvelope)
      .toEqual({ kind: 'invalid' });
  });

  test('does not let an invalid completion capability hide a valid logout intent', () => {
    const parsed = parseAuthoritativeSessionCookieHeader(
      '__Host-spott_login_intent=one; __Host-spott_login_intent=two; '
      + '__Host-spott_logout_intent=v1.7.current',
    );
    expect(parsed.loginIntentEnvelope).toEqual({ kind: 'invalid' });
    expect(parsed.logoutIntent).toEqual({ kind: 'value', value: 'v1.7.current' });
  });
});

describe('parseSessionCookieHeader', () => {
  test('extracts only the two credential envelopes without percent-decoding them', () => {
    expect(
      parseSessionCookieHeader(
        'locale=ja; __Host-spott_refresh=v1%2Eraw; ' +
          '__Host-spott_device_binding=binding%2Eraw; theme=dark',
      ),
    ).toEqual({
      kind: 'parsed',
      refreshEnvelope: 'v1%2Eraw',
      deviceBindingEnvelope: 'binding%2Eraw',
    });
  });

  test.each([
    '__Host-spott_refresh=one; __Host-spott_refresh=two',
    '__Host-spott_device_binding=one; __Host-spott_device_binding=two',
    '__Host-spott_refresh=',
    '__Host-spott_device_binding=',
    '__Host-spott_refresh; locale=ja',
    '__Host-spott_device_binding; locale=ja',
  ])('rejects duplicate, empty, or valueless credential Cookies: %s', (header) => {
    expect(parseSessionCookieHeader(header)).toEqual({ kind: 'invalid' });
  });

  test.each(['__Host-spott_refresh', '__Host-spott_device_binding'])(
    'rejects an oversized %s value before envelope decoding',
    (name) => {
      expect(parseSessionCookieHeader(`${name}=${'x'.repeat(4_097)}`)).toEqual({
        kind: 'invalid',
      });
    },
  );

  test.each([
    '__Host-spott_logout_intent=v1.1.current',
    '__Host-spott_logout_intent=',
    '__Host-spott_logout_intent',
    '__Host-spott_logout_intent=malformed',
    '__Host-spott_logout_intent=one; __Host-spott_logout_intent=two',
    `__Host-spott_refresh=${'x'.repeat(4_097)}; __Host-spott_logout_intent=malformed`,
    '__Host-spott_refresh=one; __Host-spott_refresh=two; __Host-spott_logout_intent=',
  ])('treats any logout-intent Cookie presence as a blocking state: %s', (header) => {
    expect(parseSessionCookieHeader(header)).toEqual({ kind: 'logout_intent_present' });
  });

  test("does not infer logout intent from another Cookie's value", () => {
    expect(
      parseSessionCookieHeader(
        'other=__Host-spott_logout_intent%3Dv1.1.current; __Host-spott_refresh=refresh',
      ),
    ).toEqual({
      kind: 'parsed',
      refreshEnvelope: 'refresh',
      deviceBindingEnvelope: null,
    });
  });

  test('bounds the complete header while logout intent still takes precedence', () => {
    const oversizedUnrelatedCookie = `unrelated=${'x'.repeat(16_385)}`;
    expect(parseSessionCookieHeader(oversizedUnrelatedCookie)).toEqual({ kind: 'invalid' });
    expect(
      parseSessionCookieHeader(`${oversizedUnrelatedCookie}; __Host-spott_logout_intent=`),
    ).toEqual({ kind: 'logout_intent_present' });
  });
});
