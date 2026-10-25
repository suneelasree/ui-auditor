// Scripts evaluated inside the page. Kept as plain JS strings so that
// transpiler helpers (e.g. esbuild's __name) never leak into the browser.

const CSS_PATH = String.raw`
function cssPath(el) {
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);
  if (el.id && document.querySelectorAll('#' + esc(el.id)).length === 1) return '#' + esc(el.id);
  const parts = [];
  let n = el;
  while (n && n.nodeType === 1 && n !== document.documentElement) {
    if (n.id && document.querySelectorAll('#' + esc(n.id)).length === 1) { parts.unshift('#' + esc(n.id)); break; }
    let part = n.tagName.toLowerCase();
    const cls = Array.from(n.classList).filter((c) => /^[a-zA-Z_-][\w-]*$/.test(c)).slice(0, 2);
    if (cls.length) part += '.' + cls.join('.');
    const parent = n.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === n.tagName);
      if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
    }
    parts.unshift(part);
    try { if (document.querySelectorAll(parts.join(' > ')).length === 1) break; } catch (e) {}
    n = n.parentElement;
  }
  return parts.join(' > ');
}
function isVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
  const s = getComputedStyle(el);
  if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
  if (r.right <= 0) return false;
  return true;
}
function txt(el) {
  return ((el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '') + '').replace(/\s+/g, ' ').trim().slice(0, 120);
}
`;

export const BUTTON_SELECTOR = 'button, [role=button], input[type=submit], input[type=button]';
export const CTA_SELECTOR = 'button, [role=button], a[class*=btn], [class*=cta], input[type=submit]';

const EXTRACT_BODY = String.raw`
const VALIDATING_TYPES = ['email', 'tel', 'url', 'number'];
const meta = document.querySelector('meta[name="description" i]');
const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) => ({ level: Number(h.tagName[1]), text: txt(h) }));
const links = Array.from(document.querySelectorAll('a[href]')).map((a) => ({ raw: a.getAttribute('href') || '', href: a.href, text: txt(a), selector: cssPath(a) }));
const buttons = [];
Array.from(document.querySelectorAll(BUTTON_SELECTOR)).forEach((b, index) => {
  if (!isVisible(b)) return;
  const tag = b.tagName.toLowerCase();
  const type = (b.getAttribute('type') || (tag === 'button' ? 'submit' : '')).toLowerCase();
  const inForm = !!(b.form || b.closest('form'));
  const native = (type === 'submit' || type === 'reset') && inForm;
  const href = !!b.closest('a[href]') || b.hasAttribute('href');
  const onclick = typeof b.onclick === 'function' || !!b.closest('[onclick]');
  const label = !!b.closest('label, summary');
  buttons.push({ index, selector: cssPath(b), text: txt(b), staticHandler: native || href || onclick || label });
});
const images = Array.from(document.querySelectorAll('img')).map((img) => {
  const r = img.getBoundingClientRect();
  return { src: img.currentSrc || img.src, selector: cssPath(img), alt: img.getAttribute('alt'), naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, renderedWidth: Math.round(r.width), renderedHeight: Math.round(r.height) };
});
const forms = Array.from(document.querySelectorAll('form')).map((f) => {
  let hasAttrs = false;
  const fields = Array.from(f.querySelectorAll('input, select, textarea'))
    .filter((el) => !['hidden', 'submit', 'button', 'reset', 'image'].includes((el.getAttribute('type') || '').toLowerCase()))
    .map((el) => {
      const type = el.tagName.toLowerCase() === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : el.tagName.toLowerCase();
      if (el.required || el.hasAttribute('pattern') || el.hasAttribute('min') || el.hasAttribute('max') || el.hasAttribute('minlength') || VALIDATING_TYPES.includes(type)) hasAttrs = true;
      let label = '';
      if (el.labels && el.labels.length) label = txt(el.labels[0]);
      if (!label) label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
      return { name: el.getAttribute('name') || el.id || '', type, required: !!el.required, label: label || undefined };
    });
  const hasValidation = (hasAttrs && !f.noValidate) || f.hasAttribute('onsubmit');
  return { selector: cssPath(f), action: f.getAttribute('action') || undefined, method: (f.getAttribute('method') || 'get').toLowerCase(), fields, hasValidation };
});
const ctas = [];
const ctaEls = Array.from(document.querySelectorAll(CTA_SELECTOR)).filter((el) => {
  if (el.closest('nav, header, [role=navigation], [role=banner]')) return false;
  const interactive = el.matches('a, button, input, [role=button]');
  if (!interactive && (el.querySelector(CTA_SELECTOR) || txt(el).length > 60)) return false;
  return isVisible(el);
});
for (const el of ctaEls.slice(0, 40)) {
  const r = el.getBoundingClientRect();
  ctas.push({ selector: cssPath(el), text: txt(el), box: { x: Math.round(r.x + window.scrollX), y: Math.round(r.y + window.scrollY), width: Math.round(r.width), height: Math.round(r.height) } });
}
return {
  title: document.title || '',
  lang: document.documentElement.getAttribute('lang') || null,
  metaDescription: meta ? meta.getAttribute('content') || '' : null,
  h1: Array.from(document.querySelectorAll('h1')).map(txt),
  headings,
  textSample: ((document.body && document.body.innerText) || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 3000),
  links, buttons, images, forms, ctas,
};
`;

/** Extracts everything the crawler needs from the desktop render. */
export const EXTRACT_SCRIPT = `(() => {
${CSS_PATH}
const BUTTON_SELECTOR = ${JSON.stringify(BUTTON_SELECTOR)};
const CTA_SELECTOR = ${JSON.stringify(CTA_SELECTOR)};
${EXTRACT_BODY}
})()`;

export interface ExtractResult {
  title: string;
  lang: string | null;
  metaDescription: string | null;
  h1: string[];
  headings: { level: number; text: string }[];
  textSample: string;
  links: { raw: string; href: string; text: string; selector: string }[];
  buttons: { index: number; selector: string; text: string; staticHandler: boolean }[];
  images: {
    src: string;
    selector: string;
    alt: string | null;
    naturalWidth: number;
    naturalHeight: number;
    renderedWidth: number;
    renderedHeight: number;
  }[];
  forms: {
    selector: string;
    action?: string;
    method?: string;
    fields: { name: string; type: string; required: boolean; label?: string }[];
    hasValidation: boolean;
  }[];
  ctas: { selector: string; text: string; box: { x: number; y: number; width: number; height: number } }[];
}

/** Returns the [element, ancestors..., document, window] chain for button #index. */
export function buttonChainExpression(index: number): string {
  return `(() => { const el = document.querySelectorAll(${JSON.stringify(BUTTON_SELECTOR)})[${index}]; const chain = []; let n = el; while (n) { chain.push(n); n = n.parentNode; } chain.push(window); return chain; })()`;
}

export const OVERFLOW_SCRIPT = `(() => document.documentElement.scrollWidth > window.innerWidth + 1)()`;

/** Returns visibility booleans for the given selectors, in order. */
export function visibilityScript(selectors: string[]): string {
  return `(() => { ${CSS_PATH} return ${JSON.stringify(selectors)}.map((s) => { try { return isVisible(document.querySelector(s)); } catch (e) { return false; } }); })()`;
}

export const SCROLL_SCRIPT = `(async () => { const h = Math.min(document.body ? document.body.scrollHeight : 0, 20000); for (let y = 0; y < h; y += 800) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); } window.scrollTo(0, 0); })()`;

/** Submit a form with no input. 'blocked' if native validation (or a JS handler) stops it. */
export function emptySubmitScript(selector: string): string {
  return `(() => { const f = document.querySelector(${JSON.stringify(selector)}); if (!f) return 'error'; if (!f.noValidate && !f.checkValidity()) return 'blocked'; let prevented = false; f.addEventListener('submit', (e) => { setTimeout(() => {}, 0); if (e.defaultPrevented) prevented = true; }); try { f.requestSubmit(); } catch (e) { return 'error'; } return prevented ? 'blocked' : 'submitted'; })()`;
}
