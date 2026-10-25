import { VIEWPORT_SIZES, type Finding } from '../core/types.js';

/** Path part of a page URL ("/listings"), or the raw value if it isn't a URL. */
export function pagePath(page: string): string {
  try {
    const u = new URL(page);
    return (u.pathname.replace(/\/+$/, '') || '/') + u.search;
  } catch {
    return page || '/';
  }
}

export function viewportLabel(v: Finding['viewport']): string {
  if (v === 'all') return 'all viewports';
  return `${v} ${VIEWPORT_SIZES[v].width}px`;
}

/** HTML-escape text for element content and quoted attribute values. */
export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"'`]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Only http(s) URLs may become links; anything else (javascript:, data:) is rejected. */
export function safeHttpUrl(s: string | undefined): string | null {
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}
