import { describe, expect, it } from 'vitest';
import { isCrawlable, isLogoutLike, normalizeUrl, pageKey, sameOrigin, isLocalHost } from '../../src/crawler/url.js';
import { parseRobots } from '../../src/crawler/robots.js';

describe('normalizeUrl', () => {
  it('strips hash and trailing slash, keeps query', () => {
    expect(normalizeUrl('https://a.com/listings/#top')).toBe('https://a.com/listings');
    expect(normalizeUrl('https://a.com/listings///?beds=2#x')).toBe('https://a.com/listings?beds=2');
  });
  it('keeps the root slash and lowercases host, drops default port', () => {
    expect(normalizeUrl('HTTPS://A.COM:443')).toBe('https://a.com/');
    expect(normalizeUrl('http://a.com/#hash')).toBe('http://a.com/');
  });
  it('resolves relative hrefs', () => {
    expect(normalizeUrl('../about/', 'https://a.com/listings/42')).toBe('https://a.com/about');
    expect(normalizeUrl('/contact', 'https://a.com/x')).toBe('https://a.com/contact');
  });
  it('rejects non-http links', () => {
    for (const h of ['mailto:a@b.c', 'tel:123', 'javascript:void(0)', '', 'ftp://a.com/x']) expect(normalizeUrl(h, 'https://a.com')).toBeNull();
  });
});

describe('url helpers', () => {
  it('sameOrigin', () => {
    expect(sameOrigin('https://a.com/x', 'https://a.com/y')).toBe(true);
    expect(sameOrigin('https://a.com/x', 'http://a.com/y')).toBe(false);
    expect(sameOrigin('https://b.a.com/', 'https://a.com/')).toBe(false);
  });
  it('isLogoutLike by href or text', () => {
    expect(isLogoutLike('https://a.com/logout')).toBe(true);
    expect(isLogoutLike('https://a.com/auth/signout')).toBe(true);
    expect(isLogoutLike('https://a.com/session?x=1', 'Log out')).toBe(true);
    expect(isLogoutLike('https://a.com/account', 'My account')).toBe(false);
  });
  it('isCrawlable skips asset files', () => {
    expect(isCrawlable('https://a.com/brochure.pdf')).toBe(false);
    expect(isCrawlable('https://a.com/img/a.JPG')).toBe(false);
    expect(isCrawlable('https://a.com/listings')).toBe(true);
    expect(isCrawlable('https://a.com/page.html')).toBe(true);
  });
  it('pageKey and isLocalHost', () => {
    expect(pageKey(0, 'https://a.com/')).toBe('p01-home');
    expect(pageKey(11, 'https://a.com/listings/42-harbor-view-drive')).toBe('p12-listings-42-harbor-view-drive');
    expect(isLocalHost('http://127.0.0.1:4100/')).toBe(true);
    expect(isLocalHost('https://example.com/')).toBe(false);
  });
});

describe('robots', () => {
  const rules = parseRobots('https://a.com/robots.txt', 'User-agent: *\nDisallow: /admin\nDisallow: /private/\n\nUser-agent: UIAuditor\nDisallow: /no-audit\n');
  it('honours disallow rules for our user agent', () => {
    expect(rules.isAllowed('https://a.com/no-audit/x')).toBe(false);
    expect(rules.isAllowed('https://a.com/listings')).toBe(true);
  });
  it('allows everything for empty robots.txt', () => {
    const all = parseRobots('https://a.com/robots.txt', '');
    expect(all.isAllowed('https://a.com/admin')).toBe(true);
  });
  it('applies wildcard group when no specific group matches', () => {
    const r = parseRobots('https://a.com/robots.txt', 'User-agent: *\nDisallow: /admin\n');
    expect(r.isAllowed('https://a.com/admin')).toBe(false);
    expect(r.isAllowed('https://a.com/')).toBe(true);
  });
});
