// robots.txt handling.
import robotsParser from 'robots-parser';
import type { APIRequestContext } from 'playwright';

export const CRAWLER_UA = 'UIAuditor';

export interface RobotsRules {
  isAllowed(url: string): boolean;
}

const ALLOW_ALL: RobotsRules = { isAllowed: () => true };

/** Parse robots.txt text. Anything not explicitly disallowed is allowed. */
export function parseRobots(robotsUrl: string, text: string): RobotsRules {
  const robot = robotsParser(robotsUrl, text);
  return { isAllowed: (url: string) => robot.isAllowed(url, CRAWLER_UA) !== false };
}

/** Fetch and parse `<origin>/robots.txt`. Missing or unreadable robots.txt means allow all. */
export async function fetchRobots(request: APIRequestContext, startUrl: string): Promise<RobotsRules> {
  const robotsUrl = new URL('/robots.txt', startUrl).toString();
  try {
    const res = await request.get(robotsUrl, { timeout: 10_000, failOnStatusCode: false });
    if (res.status() >= 400) return ALLOW_ALL;
    return parseRobots(robotsUrl, await res.text());
  } catch {
    return ALLOW_ALL;
  }
}
