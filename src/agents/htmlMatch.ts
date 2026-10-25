// A small, dependency-free HTML parser + CSS selector matcher, good enough to answer
// "does this selector match anything in this saved DOM?" synchronously.
// Supports: tag, *, #id, .class, [attr], [attr=v], [attr~=v], [attr|=v], [attr^=v], [attr$=v], [attr*=v],
// the " i" flag, :not(...), selector lists, and the descendant / child / sibling combinators.
// In lenient mode, other pseudo-classes (:nth-child etc.) are ignored (treated as matching).

export interface HtmlElement {
  tag: string;
  attrs: Map<string, string>;
  parent: HtmlElement | null;
  children: HtmlElement[];
}

export interface ParsedHtml {
  elements: HtmlElement[];
  /** Visible-ish text: tags stripped, scripts/styles removed, entities decoded. */
  text: string;
  /** Values of user-facing attributes (placeholder, aria-label, title, alt, value). */
  attrText: string;
}

const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
const RAW_TEXT = /<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/g;
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
const TEXT_ATTRS = ['placeholder', 'aria-label', 'title', 'alt', 'value'];

export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n: string) => safeCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => safeCodePoint(parseInt(n, 16)))
    .replace(/&amp;/gi, '&');
}

function safeCodePoint(n: number): string {
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

export function parseHtml(html: string): ParsedHtml {
  const cleaned = html.replace(/<!--[\s\S]*?-->/g, ' ');
  // Keep the opening tags of raw-text elements (so `script[src]` still matches) but drop their content.
  const noRaw = cleaned.replace(RAW_TEXT, (m, tag: string) => {
    const open = m.match(/^<[^>]*>/)?.[0] ?? '';
    return `${open}</${tag}>`;
  });

  const root: HtmlElement = { tag: '#root', attrs: new Map(), parent: null, children: [] };
  const elements: HtmlElement[] = [];
  const stack: HtmlElement[] = [root];
  const attrValues: string[] = [];

  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(noRaw))) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const attrs = new Map<string, string>();
    ATTR_RE.lastIndex = 0;
    let a: RegExpExecArray | null;
    const rawAttrs = m[3] ?? '';
    while ((a = ATTR_RE.exec(rawAttrs))) {
      const name = a[1].toLowerCase();
      if (attrs.has(name)) continue;
      const value = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
      attrs.set(name, value);
      if (TEXT_ATTRS.includes(name) && value) attrValues.push(value);
    }
    const parent = stack[stack.length - 1];
    const el: HtmlElement = { tag, attrs, parent: parent === root ? null : parent, children: [] };
    parent.children.push(el);
    elements.push(el);
    if (!VOID.has(tag) && m[4] !== '/') stack.push(el);
  }

  const text = decodeEntities(noRaw.replace(RAW_TEXT, ' ').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  return { elements, text, attrText: attrValues.join(' \n ') };
}

// ---------- Selector parsing ----------

type AttrOp = '' | '=' | '~=' | '|=' | '^=' | '$=' | '*=';
interface AttrSel {
  name: string;
  op: AttrOp;
  value: string;
  insensitive: boolean;
}
interface Compound {
  tag: string | null;
  ids: string[];
  classes: string[];
  attrs: AttrSel[];
  nots: Compound[][];
}
type Combinator = ' ' | '>' | '+' | '~';
interface Complex {
  compounds: Compound[];
  /** combinators[i] joins compounds[i] and compounds[i + 1] */
  combinators: Combinator[];
}

export class SelectorSyntaxError extends Error {}

const IDENT = /^-?(?:[_a-zA-Z0-9\u00a0-\uffff-]|\\.)+/;

function unescapeIdent(s: string): string {
  return s.replace(/\\(.)/g, '$1');
}

/** Split on top-level commas (outside brackets, parens and quotes). */
function splitTopLevel(input: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === '\\') {
        cur += ch + (input[++i] ?? '');
        continue;
      }
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

export function parseSelector(selector: string, lenient = false): Complex[] {
  const parts = splitTopLevel(selector, ',');
  if (parts.length === 0) throw new SelectorSyntaxError(`Empty selector`);
  return parts.map((p) => parseComplex(p, lenient));
}

function parseComplex(input: string, lenient: boolean): Complex {
  const compounds: Compound[] = [];
  const combinators: Combinator[] = [];
  let s = input.trim();
  let pending: Combinator | null = null;
  while (s.length) {
    const comb = s.match(/^\s*([>+~])\s*/) ?? (compounds.length ? s.match(/^(\s+)/) : null);
    if (comb && compounds.length) {
      const c = comb[1].trim();
      pending = (c === '' ? ' ' : c) as Combinator;
      s = s.slice(comb[0].length);
      continue;
    }
    const [compound, rest] = parseCompound(s, lenient);
    if (compounds.length) combinators.push(pending ?? ' ');
    pending = null;
    compounds.push(compound);
    s = rest;
  }
  if (!compounds.length || pending) throw new SelectorSyntaxError(`Bad selector: ${input}`);
  return { compounds, combinators };
}

function parseCompound(input: string, lenient: boolean): [Compound, string] {
  const c: Compound = { tag: null, ids: [], classes: [], attrs: [], nots: [] };
  let s = input;
  const tagM = s.match(/^(\*|[a-zA-Z][a-zA-Z0-9-]*)/);
  if (tagM) {
    c.tag = tagM[1] === '*' ? null : tagM[1].toLowerCase();
    s = s.slice(tagM[0].length);
  }
  let progressed = !!tagM;
  for (;;) {
    if (s.startsWith('#') || s.startsWith('.')) {
      const id = s.slice(1).match(IDENT);
      if (!id) throw new SelectorSyntaxError(`Bad selector near "${s}"`);
      (s[0] === '#' ? c.ids : c.classes).push(unescapeIdent(id[0]));
      s = s.slice(1 + id[0].length);
    } else if (s.startsWith('[')) {
      const am = s.match(
        /^\[\s*([^\s~|^$*=\]]+)\s*(?:([~|^$*]?=)\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s\]]+))\s*([iIsS])?\s*)?\]/,
      );
      if (!am) throw new SelectorSyntaxError(`Bad attribute selector near "${s}"`);
      c.attrs.push({
        name: am[1].toLowerCase(),
        op: (am[2] ?? '') as AttrOp,
        value: unescapeIdent(am[3] ?? am[4] ?? am[5] ?? ''),
        insensitive: (am[6] ?? '').toLowerCase() === 'i',
      });
      s = s.slice(am[0].length);
    } else if (s.startsWith(':')) {
      const pm = s.match(/^::?([a-zA-Z-]+)/);
      if (!pm) throw new SelectorSyntaxError(`Bad pseudo near "${s}"`);
      const name = pm[1].toLowerCase();
      s = s.slice(pm[0].length);
      let arg: string | null = null;
      if (s.startsWith('(')) {
        let depth = 0;
        let i = 0;
        for (; i < s.length; i++) {
          if (s[i] === '(') depth++;
          else if (s[i] === ')' && --depth === 0) break;
        }
        if (depth !== 0) throw new SelectorSyntaxError(`Unbalanced parens in "${input}"`);
        arg = s.slice(1, i);
        s = s.slice(i + 1);
      }
      if (name === 'not' && arg !== null) {
        c.nots.push(splitTopLevel(arg, ',').map((a) => parseCompoundWhole(a, lenient)));
      } else if (!lenient) {
        throw new SelectorSyntaxError(`Unsupported pseudo-class :${name} in "${input}"`);
      }
    } else {
      break;
    }
    progressed = true;
  }
  if (!progressed) throw new SelectorSyntaxError(`Bad selector near "${input}"`);
  return [c, s];
}

function parseCompoundWhole(input: string, lenient: boolean): Compound {
  const [c, rest] = parseCompound(input.trim(), lenient);
  if (rest.trim()) throw new SelectorSyntaxError(`Only simple selectors are supported inside :not(): "${input}"`);
  return c;
}

// ---------- Matching ----------

function matchAttr(el: HtmlElement, a: AttrSel): boolean {
  const actual = el.attrs.get(a.name);
  if (actual === undefined) return false;
  if (a.op === '') return true;
  const v = a.insensitive ? actual.toLowerCase() : actual;
  const want = a.insensitive ? a.value.toLowerCase() : a.value;
  switch (a.op) {
    case '=':
      return v === want;
    case '~=':
      return want !== '' && v.split(/\s+/).includes(want);
    case '|=':
      return v === want || v.startsWith(want + '-');
    case '^=':
      return want !== '' && v.startsWith(want);
    case '$=':
      return want !== '' && v.endsWith(want);
    case '*=':
      return want !== '' && v.includes(want);
  }
}

function matchCompound(el: HtmlElement, c: Compound): boolean {
  if (c.tag && el.tag !== c.tag) return false;
  if (c.ids.length && !c.ids.every((id) => el.attrs.get('id') === id)) return false;
  if (c.classes.length) {
    const cls = (el.attrs.get('class') ?? '').split(/\s+/);
    if (!c.classes.every((k) => cls.includes(k))) return false;
  }
  if (!c.attrs.every((a) => matchAttr(el, a))) return false;
  if (c.nots.some((list) => list.some((n) => matchCompound(el, n)))) return false;
  return true;
}

function prevSiblings(el: HtmlElement, all: HtmlElement[]): HtmlElement[] {
  const siblings = el.parent ? el.parent.children : all.filter((e) => e.parent === null);
  const idx = siblings.indexOf(el);
  return idx <= 0 ? [] : siblings.slice(0, idx);
}

function matchComplexAt(el: HtmlElement, cx: Complex, i: number, all: HtmlElement[]): boolean {
  if (!matchCompound(el, cx.compounds[i])) return false;
  if (i === 0) return true;
  const comb = cx.combinators[i - 1];
  if (comb === '>') return !!el.parent && matchComplexAt(el.parent, cx, i - 1, all);
  if (comb === ' ') {
    for (let p = el.parent; p; p = p.parent) if (matchComplexAt(p, cx, i - 1, all)) return true;
    return false;
  }
  const prev = prevSiblings(el, all);
  if (comb === '+') return prev.length > 0 && matchComplexAt(prev[prev.length - 1], cx, i - 1, all);
  return prev.some((p) => matchComplexAt(p, cx, i - 1, all));
}

/** Returns true when the selector matches at least one element. */
export function selectorMatches(doc: ParsedHtml, selector: string, opts: { lenient?: boolean } = {}): boolean {
  const list = parseSelector(selector, opts.lenient ?? false);
  return doc.elements.some((el) => list.some((cx) => matchComplexAt(el, cx, cx.compounds.length - 1, doc.elements)));
}

/** Escape a string for use in a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Case-insensitive, word-boundary keyword regex; whitespace inside the keyword matches any whitespace. */
export function keywordRegex(keyword: string, flags = 'iu'): RegExp {
  const body = keyword
    .trim()
    .split(/\s+/)
    .map(escapeRe)
    .join('\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, flags);
}
