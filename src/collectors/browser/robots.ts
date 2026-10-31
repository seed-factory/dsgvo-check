/**
 * robots.txt (RFC 9309) for additional pages only (D09: start and legal pages are always visited) and a minimal
 * sitemap `<loc>` reader for page selection fallback.
 */

interface Rule {
  allow: boolean;
  pattern: string;
}

interface Group {
  agents: string[];
  rules: Rule[];
}

export interface Robots {
  groups: Group[];
  sitemaps: string[];
}

export function parseRobots(text: string): Robots {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = (m[1] as string).toLowerCase();
    const value = (m[2] as string).trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === 'sitemap') {
      if (value) sitemaps.push(value);
    } else if ((key === 'allow' || key === 'disallow') && current) {
      if (value) current.rules.push({ allow: key === 'allow', pattern: value });
    }
  }
  return { groups, sitemaps };
}

function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

/** Is `pathWithQuery` allowed for `token`? The group naming the token wins over `*`; longest match, allow on ties. */
export function robotsAllows(robots: Robots, pathWithQuery: string, token: string): boolean {
  const t = token.toLowerCase();
  const own = robots.groups.filter((g) => g.agents.some((a) => a !== '*' && t.startsWith(a)));
  const groups = own.length > 0 ? own : robots.groups.filter((g) => g.agents.includes('*'));
  let best: Rule | null = null;
  for (const rule of groups.flatMap((g) => g.rules)) {
    if (!patternToRegex(rule.pattern).test(pathWithQuery)) continue;
    if (
      !best ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow)
    ) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function parseSitemap(xml: string): { kind: 'urlset' | 'index'; locs: string[] } {
  const kind = /<sitemapindex[\s>]/i.test(xml) ? 'index' : 'urlset';
  const locs: string[] = [];
  for (const m of xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/loc>/gi)) {
    const v = decodeXml((m[1] as string).trim());
    if (v) locs.push(v);
  }
  return { kind, locs };
}
