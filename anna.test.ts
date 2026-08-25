import { describe, expect, it } from '@jest/globals';
import { ANNAS_TRUSTED_HOSTS, isTrustedAnnaURL, parseAnnaBaseURLs } from './anna';

describe('Anna domain configuration', () => {
  it('normalizes and deduplicates comma-separated HTTPS origins', () => {
    expect(parseAnnaBaseURLs('https://annas-archive.example/, https://annas-archive.example, https://mirror.example', 'https://unused.example', 'TEST_URLS')).toEqual([
      'https://annas-archive.example',
      'https://mirror.example',
    ]);
  });

  it.each([
    'http://annas-archive.example',
    'https://user:password@annas-archive.example',
    'https://annas-archive.example:8443',
    'https://annas-archive.example/path',
  ])('rejects unsafe base URL configuration: %s', (value) => {
    expect(() => parseAnnaBaseURLs(value, 'https://unused.example', 'TEST_URLS')).toThrow();
  });

  it('trusts exact configured hosts and rejects lookalike subdomains', () => {
    const configuredHost = [...ANNAS_TRUSTED_HOSTS][0];
    expect(isTrustedAnnaURL(`https://${configuredHost}/md5/abc123`, '/md5/abc123')).toBe(true);
    expect(isTrustedAnnaURL(`https://${configuredHost}.attacker.example/md5/abc123`, '/md5/abc123')).toBe(false);
    expect(isTrustedAnnaURL(`http://${configuredHost}/md5/abc123`, '/md5/abc123')).toBe(false);
    expect(isTrustedAnnaURL(`https://${configuredHost}/md5/wrong`, '/md5/abc123')).toBe(false);
  });
});
