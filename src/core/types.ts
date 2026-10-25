// Shared contracts for the whole engine. Every module imports from here.
import { z } from 'zod';

// ---------- Options ----------

/** Only http(s) URLs may be audited or used for login (rejects file:, javascript:, ...). */
const HttpUrl = z.string().url().refine((u) => /^https?:\/\//i.test(u), 'Must be an http(s) URL');

export const VIEWPORTS = ['desktop', 'tablet', 'mobile'] as const;
export const Viewport = z.enum(VIEWPORTS);
export type Viewport = z.infer<typeof Viewport>;

export const VIEWPORT_SIZES: Record<Viewport, { width: number; height: number }> = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 375, height: 812 },
};

export const DOMAIN_NAMES = [
  'real-estate',
  'ecommerce',
  'saas',
  'healthcare',
  'banking',
  'travel',
  'education',
  'generic',
] as const;
export const DomainName = z.enum(DOMAIN_NAMES);
export type DomainName = z.infer<typeof DomainName>;
export const DomainOption = z.union([z.literal('auto'), DomainName]);

export const LoginConfig = z.object({
  loginUrl: HttpUrl,
  usernameSelector: z.string().optional(),
  passwordSelector: z.string().optional(),
  submitSelector: z.string().optional(),
  /** Choices to make after submitting, in order, e.g. a tenant picker: ["Acme QA"]. Each is visible text or a CSS selector. */
  afterLoginChoose: z.array(z.string().min(1)).max(5).optional(),
  /** Login succeeded when the URL contains this string... */
  successUrlContains: z.string().optional(),
  /** ...or when this selector is visible. */
  successSelector: z.string().optional(),
});
export type LoginConfig = z.infer<typeof LoginConfig>;

export const AuditOptions = z.object({
  url: HttpUrl,
  depth: z.number().int().min(0).max(5).default(2),
  maxPages: z.number().int().min(1).max(100).default(15),
  domain: DomainOption.default('auto'),
  viewports: z.array(Viewport).min(1).default(['desktop', 'tablet', 'mobile']),
  competitors: z.array(HttpUrl).max(2).default([]),
  login: LoginConfig.optional(),
  allowForms: z.boolean().default(false),
  lighthouse: z.boolean().default(true),
  respectRobots: z.boolean().default(true),
  rateLimitMs: z.number().int().min(0).default(300),
});
export type AuditOptions = z.output<typeof AuditOptions>;
export type AuditOptionsInput = z.input<typeof AuditOptions>;

/** Never serialized, never logged. Lives only in memory for one run. */
export interface Credentials {
  username: string;
  password: string;
}

// ---------- Evidence (collected deterministically by the crawler) ----------

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ElementEvidence {
  selector: string;
  text?: string;
  box?: Box;
  /** Path relative to the run directory, e.g. "evidence/p1-desktop-el3.png" */
  screenshot?: string;
}

export interface LinkCheck {
  href: string;
  text: string;
  selector: string;
  internal: boolean;
  status: number | null;
  ok: boolean;
  error?: string;
}

export interface ConsoleEntry {
  type: 'error' | 'warning';
  text: string;
  location?: string;
}

export interface NetworkFailure {
  url: string;
  method: string;
  resourceType: string;
  status: number | null;
  failure?: string;
}

export interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  helpUrl: string;
  nodes: { target: string; html: string; failureSummary?: string }[];
}

export interface ImageEvidence {
  src: string;
  selector: string;
  alt: string | null;
  naturalWidth: number;
  naturalHeight: number;
  renderedWidth: number;
  renderedHeight: number;
  bytes?: number;
}

export interface FormField {
  name: string;
  type: string;
  required: boolean;
  label?: string;
}

export interface FormEvidence {
  selector: string;
  action?: string;
  method?: string;
  fields: FormField[];
  /** true if any field has required/pattern/min/max/type=email etc. or the form has a JS validation hook */
  hasValidation: boolean;
  /** Only present when allowForms was on and the crawler submitted it empty */
  emptySubmitResult?: 'blocked' | 'submitted' | 'error';
}

export interface ButtonEvidence {
  selector: string;
  text: string;
  /** true if the element or an ancestor has a click listener, an href, or is a form submit */
  hasHandler: boolean;
}

export interface ViewportCapture {
  viewport: Viewport;
  /** Full-page screenshot, relative path */
  screenshot: string;
  /** First screen only (viewport-sized), relative path. This is what goes to vision models. */
  aboveFold: string;
  axe: AxeViolation[];
  /** CTA-like elements visible on desktop but hidden at this viewport (outside nav/header) */
  hiddenCtas: ElementEvidence[];
  horizontalOverflow: boolean;
}

export interface LighthouseMetrics {
  performance: number | null;
  accessibility: number | null;
  bestPractices: number | null;
  seo: number | null;
  lcpMs: number | null;
  cls: number | null;
  tbtMs: number | null;
  fcpMs: number | null;
}

export interface PageEvidence {
  url: string;
  path: string;
  title: string;
  depth: number;
  status: number | null;
  lang: string | null;
  metaDescription: string | null;
  h1: string[];
  headings: { level: number; text: string }[];
  /** First ~3000 chars of visible text */
  textSample: string;
  links: LinkCheck[];
  buttons: ButtonEvidence[];
  images: ImageEvidence[];
  forms: FormEvidence[];
  console: ConsoleEntry[];
  networkFailures: NetworkFailure[];
  securityHeaders: Record<string, string | null>;
  captures: ViewportCapture[];
  lighthouse?: LighthouseMetrics;
  /** true if this page was only reachable after login */
  requiresLogin: boolean;
  /** Saved DOM, relative path */
  domSnapshot: string;
}

export interface NavNode {
  url: string;
  title: string;
  depth: number;
  outLinks: number;
  inLinks: number;
  deadEnd: boolean;
  orphan: boolean;
}

export interface NavGraph {
  nodes: NavNode[];
  edges: { from: string; to: string }[];
  brokenLinks: { from: string; href: string; status: number | null }[];
}

export interface EvidenceBundle {
  /** Absolute path of the run directory; evidence paths are relative to it */
  runDir: string;
  startUrl: string;
  startedAt: string;
  pages: PageEvidence[];
  nav: NavGraph;
  robotsBlocked: string[];
  loginUsed: boolean;
  /** A login or saved session was used, but the start page still showed a sign-in form (expired session). */
  signInLost?: boolean;
  /** Non-fatal crawl problems, already redacted */
  errors: string[];
}

// ---------- Findings ----------

export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'] as const;
export const Severity = z.enum(SEVERITIES);
export type Severity = z.infer<typeof Severity>;

export const CATEGORIES = [
  'UX',
  'Navigation',
  'Functional',
  'Accessibility',
  'Performance',
  'SEO',
  'Security',
  'Domain',
] as const;
export const Category = z.enum(CATEGORIES);
export type Category = z.infer<typeof Category>;

export const PERSONAS = [
  'UX Designer',
  'Senior Engineer',
  'SDET',
  'Accessibility',
  'Domain Expert',
  'Rules',
] as const;
export const Persona = z.enum(PERSONAS);
export type Persona = z.infer<typeof Persona>;

export const EVIDENCE_KINDS = [
  'screenshot',
  'selector',
  'axe-rule',
  'console',
  'network',
  'metric',
  'link',
  'domain-check',
] as const;

export const EvidenceItem = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  /** The checkable value: a selector, axe rule id, console text, request URL, metric name=value, link href, or check id */
  value: z.string().min(1),
  detail: z.string().optional(),
  /** Relative path inside the run dir */
  screenshot: z.string().optional(),
  region: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
});
export type EvidenceItem = z.infer<typeof EvidenceItem>;

export const DesignAlternative = z.object({
  /** Relative paths inside the run dir */
  original: z.string().optional(),
  goodHtml: z.string(),
  goodScreenshot: z.string(),
  betterHtml: z.string(),
  betterScreenshot: z.string(),
  goodSummary: z.string(),
  betterSummary: z.string(),
});
export type DesignAlternative = z.infer<typeof DesignAlternative>;

/** What an agent (or the rules engine) returns, before IDs are assigned. */
export const RawFinding = z.object({
  title: z.string().min(3),
  category: Category,
  severity: Severity,
  page: z.string(),
  viewport: z.union([Viewport, z.literal('all')]),
  evidence: z.array(EvidenceItem).min(1),
  stepsToReproduce: z.array(z.string()).min(1),
  expected: z.string(),
  actual: z.string(),
  recommendation: z.string(),
});
export type RawFinding = z.infer<typeof RawFinding>;

export const Finding = RawFinding.extend({
  id: z.string(),
  fingerprint: z.string(),
  foundBy: z.array(Persona).min(1),
  source: z.enum(['rule', 'agent']),
  designAlternative: DesignAlternative.optional(),
});
export type Finding = z.infer<typeof Finding>;

/** A raw finding tagged with who produced it; input to dedupe. */
export interface AttributedFinding extends RawFinding {
  foundBy: Persona;
  source: 'rule' | 'agent';
}

// ---------- Domain packs ----------

export const DomainCheck = z.object({
  id: z.string(),
  title: z.string(),
  /** The pattern phrased positively ("Sortable listings"), used in competitor comparisons. Defaults to the title without a leading "No". */
  positive: z.string().optional(),
  description: z.string(),
  severity: Severity,
  /** Pattern counts as present if ANY selector matches OR ANY keyword appears on ANY crawled page */
  signals: z.object({
    selectors: z.array(z.string()).default([]),
    keywords: z.array(z.string()).default([]),
  }),
  recommendation: z.string(),
});
export type DomainCheck = z.infer<typeof DomainCheck>;

export const DomainPack = z.object({
  name: DomainName,
  displayName: z.string(),
  detect: z.object({
    keywords: z.array(z.string()).min(1),
    /** Minimum keyword hits across crawled text to claim this domain */
    minScore: z.number().int().min(1),
  }),
  checks: z.array(DomainCheck),
});
export type DomainPack = z.infer<typeof DomainPack>;

// ---------- Report ----------

export type Scores = { overall: number; byCategory: Record<Category, number> };

export interface AgentRunInfo {
  name: Persona | 'Design Recommender' | 'Competitor Analyst';
  status: 'ok' | 'skipped' | 'failed';
  findings: number;
  /** Findings dropped because their evidence could not be matched to the bundle */
  dropped: number;
  note?: string;
}

export interface ComparisonSite {
  url: string;
  label: string;
  isTarget: boolean;
  scores: Scores;
  screenshot?: string;
}

export interface Comparison {
  sites: ComparisonSite[];
  theyDoBetter: { competitor: string; title: string; detail: string; screenshot?: string }[];
  youWin: string[];
  patternsToCopy: string[];
}

export interface Report {
  id: string;
  version: 1;
  createdAt: string;
  finishedAt: string;
  target: string;
  /** Options with nothing secret in them */
  options: AuditOptions;
  domain: { name: DomainName; detected: boolean; confidence: number };
  scores: Scores;
  summary: { topIssues: string[]; counts: Record<Severity, number>; pagesAudited: number };
  findings: Finding[];
  nav: NavGraph;
  pages: { url: string; title: string; screenshot?: string; requiresLogin: boolean }[];
  domainInsights: string[];
  comparison?: Comparison;
  agents: AgentRunInfo[];
  /** Relative paths of generated Playwright specs */
  generatedTests: string[];
  /** Notes such as "AI agents skipped: ANTHROPIC_API_KEY not set" */
  notes: string[];
}

// ---------- Progress ----------

export type Stage = 'crawl' | 'login' | 'rules' | 'agents' | 'competitors' | 'design' | 'report' | 'done' | 'error';

export interface ProgressEvent {
  runId: string;
  ts: string;
  stage: Stage;
  agent?: string;
  status: 'started' | 'progress' | 'done' | 'skipped' | 'failed';
  message: string;
  /** 0-100 overall */
  pct?: number;
}

export type ProgressFn = (e: Omit<ProgressEvent, 'runId' | 'ts'>) => void;
