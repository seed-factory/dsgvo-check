/** Pure: robots.txt (additional pages only, D09) and sitemap parsing. */
import { describe, expect, it } from 'vitest';
import { parseRobots, parseSitemap, robotsAllows } from '../../../../src/collectors/browser/robots.ts';

const ROBOTS = `
# comment
User-agent: Googlebot
Disallow: /

User-agent: *
Disallow: /intern/
Disallow: /*.pdf$
Allow: /intern/presse
Sitemap: https://www.example.test/sitemap.xml

User-agent: dsgvo-check
Disallow: /shop
`;

describe('robots', () => {
  const r = parseRobots(ROBOTS);

  it('collects sitemaps', () => {
    expect(r.sitemaps).toEqual(['https://www.example.test/sitemap.xml']);
  });

  it('applies the most specific group: our token over *', () => {
    expect(robotsAllows(r, '/shop/x', 'dsgvo-check')).toBe(false);
    // our group replaces "*": /intern is allowed for us
    expect(robotsAllows(r, '/intern/a', 'dsgvo-check')).toBe(true);
  });

  it('uses * when there is no group for the token; longest match wins; wildcards and $ work', () => {
    const star = parseRobots(ROBOTS.replace(/User-agent: dsgvo-check[\s\S]*$/, ''));
    expect(robotsAllows(star, '/intern/a', 'dsgvo-check')).toBe(false);
    expect(robotsAllows(star, '/intern/presse/1', 'dsgvo-check')).toBe(true);
    expect(robotsAllows(star, '/files/a.pdf', 'dsgvo-check')).toBe(false);
    expect(robotsAllows(star, '/files/a.pdf?x', 'dsgvo-check')).toBe(true);
    expect(robotsAllows(star, '/', 'dsgvo-check')).toBe(true);
  });

  it('an empty or missing robots.txt allows everything', () => {
    expect(robotsAllows(parseRobots(''), '/anything', 'dsgvo-check')).toBe(true);
  });
});

describe('parseSitemap', () => {
  it('reads <loc> entries of urlsets and sitemap indexes', () => {
    expect(
      parseSitemap(`<?xml version="1.0"?><urlset><url><loc> https://www.example.test/a </loc></url>
      <url><loc>https://www.example.test/b?x=1&amp;y=2</loc></url></urlset>`),
    ).toEqual({ kind: 'urlset', locs: ['https://www.example.test/a', 'https://www.example.test/b?x=1&y=2'] });
    expect(
      parseSitemap(
        '<sitemapindex><sitemap><loc>https://www.example.test/s1.xml</loc></sitemap></sitemapindex>',
      ),
    ).toEqual({
      kind: 'index',
      locs: ['https://www.example.test/s1.xml'],
    });
  });
});
