// URL helpers for the crawler: normalisation, origin checks, link filtering.

const NON_PAGE_EXT = /\.(pdf|zip|gz|tar|rar|7z|png|jpe?g|gif|webp|avif|svg|ico|bmp|mp4|webm|mov|mp3|wav|ogg|css|js|mjs|json|xml|txt|csv|xlsx?|docx?|pptx?|woff2?|ttf|eot|exe|dmg|apk)$/i;

/**
 * Resolve `href` against `base` and normalise it: http(s) only, hash stripped,
 * trailing slash stripped from non-root paths. Returns null for unusable hrefs.
 * The root path keeps its slash (`https://a.com/`) because URL always serialises it.
 */
export function normalizeUrl(href: string, base?: string): string | null {
  const raw = href.trim();
  if (!raw || /^(javascript|mailto|tel|data|blob|sms|ftp):/i.test(raw)) return null;
  let u: URL;
  try {
    u = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '') || '/';
  return u.toString();
}

export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** Links that would end the logged-in session; never followed or fetched. */
export function isLogoutLike(href: string, text = ''): boolean {
  const h = href.toLowerCase();
  const t = text.toLowerCase();
  const re = /(log[-_ ]?out|sign[-_ ]?out|signoff|sign[-_ ]?off)/;
  return re.test(h) || re.test(t);
}

/** True when the URL looks like a document/page worth crawling (not an asset download). */
export function isCrawlable(url: string): boolean {
  try {
    return !NON_PAGE_EXT.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export function isLocalHost(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost');
  } catch {
    return false;
  }
}

/** Short, filesystem-safe key for a page: p01-home, p02-listings, ... */
export function pageKey(index: number, url: string): string {
  let slug = 'home';
  try {
    const u = new URL(url);
    const s = (u.pathname + u.search).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    if (s) slug = s.toLowerCase();
  } catch {
    /* keep default */
  }
  return `p${String(index + 1).padStart(2, '0')}-${slug}`;
}
