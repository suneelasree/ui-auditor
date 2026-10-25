// Orchestrates one audit: crawl -> rules -> agents -> competitors -> designs -> report.
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  SEVERITIES,
  type AgentRunInfo,
  type AttributedFinding,
  type AuditOptions,
  type Comparison,
  type Credentials,
  type ProgressEvent,
  type ProgressFn,
  type Report,
  type Severity,
} from '../core/types.js';
import { redact, redactDeep, registerSecret, unregisterSecret } from '../core/redact.js';
import { createLlmClient, type LlmClient } from '../agents/claude.js';
import { crawl } from '../crawler/crawl.js';
import { ruleFindings } from '../rules/ruleFindings.js';
import { detectDomain, domainCheckFindings, loadDomainPacks } from '../agents/domain.js';
import { runSpecialists } from '../agents/specialists.js';
import { validateEvidence } from '../agents/evidence.js';
import { recommendDesigns } from '../design/recommender.js';
import { compareCompetitors } from '../competitor/compare.js';
import { dedupe } from '../report/dedupe.js';
import { computeScores } from '../report/scoring.js';
import { generateTests } from '../report/testgen.js';
import { writeReport } from '../report/write.js';

export interface RunAuditInput {
  options: AuditOptions;
  credentials?: Credentials;
  /** Playwright storage state from a sign-in the user did in the Web UI; used when no credentials are given. */
  sessionStatePath?: string;
  reportsDir: string;
  runId?: string;
  /** Omit to build one from env; pass null to force-skip AI agents. */
  llm?: LlmClient | null;
  onProgress?: (e: ProgressEvent) => void;
}

export interface RunMeta {
  id: string;
  url: string;
  status: 'running' | 'done' | 'failed';
  createdAt: string;
  finishedAt?: string;
  overall?: number;
  error?: string;
}

export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  return `${stamp}-${randomUUID().slice(0, 6)}`;
}

export async function runAudit(input: RunAuditInput): Promise<Report> {
  const { options, credentials } = input;
  const runId = input.runId ?? newRunId();
  const runDir = resolve(input.reportsDir, runId);
  mkdirSync(join(runDir, 'evidence'), { recursive: true });
  const llm = input.llm === undefined ? createLlmClient() : input.llm;
  const createdAt = new Date().toISOString();

  registerSecret(credentials?.password);
  registerSecret(credentials?.username);

  const meta: RunMeta = { id: runId, url: options.url, status: 'running', createdAt };
  const saveMeta = () => writeFileSync(join(runDir, 'meta.json'), JSON.stringify(meta, null, 2));
  saveMeta();

  const progress: ProgressFn = (e) => {
    const event: ProgressEvent = { ...e, message: redact(e.message), runId, ts: new Date().toISOString() };
    appendFileSync(join(runDir, 'progress.jsonl'), JSON.stringify(event) + '\n');
    input.onProgress?.(event);
  };

  try {
    const notes: string[] = [];
    const agents: AgentRunInfo[] = [];

    // 1. Evidence
    progress({ stage: 'crawl', status: 'started', message: `Crawling ${options.url}`, pct: 2 });
    const bundle = await crawl({ options, runDir, credentials, sessionStatePath: input.sessionStatePath, onProgress: progress });
    progress({ stage: 'crawl', status: 'done', message: `Crawled ${bundle.pages.length} pages`, pct: 35 });
    if (bundle.pages.length === 0) throw new Error(`Could not load ${options.url}`);
    if (input.sessionStatePath && bundle.signInLost) {
      // An expired saved session is useless; remove it so the Web UI asks the user to sign in again.
      rmSync(input.sessionStatePath, { force: true });
      throw new Error(`Your saved sign-in for ${new URL(options.url).host} has expired. Sign in again and re-run the audit.`);
    }

    // 2. Deterministic findings
    const packs = loadDomainPacks();
    const detected = detectDomain(bundle, packs, options.domain);
    const pack = packs.find((p) => p.name === detected.name) ?? packs.find((p) => p.name === 'generic')!;
    const deterministic: AttributedFinding[] = [...ruleFindings(bundle), ...domainCheckFindings(bundle, pack)];
    const ruleCheck = validateEvidence(deterministic, bundle);
    agents.push({ name: 'Rules', status: 'ok', findings: ruleCheck.kept.length, dropped: ruleCheck.dropped });
    progress({ stage: 'rules', status: 'done', message: `${ruleCheck.kept.length} rule-based findings; domain: ${pack.displayName}`, pct: 40 });

    // 3. AI specialists
    let aiFindings: AttributedFinding[] = [];
    let domainInsights: string[] = [];
    if (llm) {
      progress({ stage: 'agents', status: 'started', message: 'Running specialist agents', pct: 42 });
      const result = await runSpecialists({ bundle, domain: pack, llm, onProgress: progress });
      aiFindings = result.findings;
      domainInsights = result.domainInsights;
      agents.push(...result.agents);
      progress({ stage: 'agents', status: 'done', message: `${aiFindings.length} findings from agents`, pct: 70 });
    } else {
      notes.push('AI agents skipped: ANTHROPIC_API_KEY is not set. Only rule-based findings are included.');
      progress({ stage: 'agents', status: 'skipped', message: 'AI agents skipped (no ANTHROPIC_API_KEY)', pct: 70 });
    }

    const findings = dedupe([...ruleCheck.kept, ...aiFindings]);
    const scores = computeScores(findings);

    // 4. Competitors
    let comparison: Comparison | undefined;
    if (options.competitors.length > 0) {
      progress({ stage: 'competitors', status: 'started', message: `Comparing with ${options.competitors.length} competitor(s)`, pct: 72 });
      const result = await compareCompetitors({
        target: { bundle, findings, scores },
        competitorUrls: options.competitors,
        options,
        runDir,
        llm,
        domain: pack,
        onProgress: progress,
      });
      comparison = result.comparison;
      agents.push(result.info);
      progress({
        stage: 'competitors',
        agent: result.info.name,
        status: result.info.status === 'failed' ? 'failed' : 'done',
        message: result.info.note ?? 'Comparison ready',
        pct: 82,
      });
    }

    // 5. Design alternatives for the top issues
    progress({ stage: 'design', status: 'started', message: 'Designing Good/Better alternatives', pct: 84 });
    const designs = await recommendDesigns({ findings, bundle, llm, runDir, onProgress: progress });
    agents.push(designs.info);
    for (const f of findings) {
      const alt = designs.alternatives.get(f.id);
      if (alt) f.designAlternative = alt;
    }
    progress({ stage: 'design', status: designs.info.status === 'ok' ? 'done' : 'skipped', message: designs.info.note ?? `${designs.alternatives.size} design alternatives`, pct: 92 });

    // 6. Report
    const generatedTests = generateTests(findings, bundle, runDir);
    const counts = Object.fromEntries(SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length])) as Record<Severity, number>;
    const report: Report = redactDeep({
      id: runId,
      version: 1,
      createdAt,
      finishedAt: new Date().toISOString(),
      target: options.url,
      options,
      domain: { name: pack.name, detected: detected.detected, confidence: detected.confidence },
      scores,
      summary: { topIssues: findings.slice(0, 5).map((f) => f.id), counts, pagesAudited: bundle.pages.length },
      findings,
      nav: bundle.nav,
      pages: bundle.pages.map((p) => ({
        url: p.url,
        title: p.title,
        screenshot: p.captures[0]?.aboveFold,
        requiresLogin: p.requiresLogin,
      })),
      domainInsights,
      comparison,
      agents,
      generatedTests,
      notes: [...notes, ...bundle.errors.slice(0, 20).map((e) => `Crawl warning: ${e}`)],
    });
    await writeReport(report, runDir);

    meta.status = 'done';
    meta.finishedAt = report.finishedAt;
    meta.overall = scores.overall;
    saveMeta();
    progress({ stage: 'done', status: 'done', message: `Audit complete: score ${scores.overall}/100, ${findings.length} findings`, pct: 100 });
    return report;
  } catch (err) {
    meta.status = 'failed';
    meta.error = redact(err instanceof Error ? err.message : String(err));
    meta.finishedAt = new Date().toISOString();
    saveMeta();
    progress({ stage: 'error', status: 'failed', message: meta.error });
    throw err;
  } finally {
    rmSync(join(runDir, '.auth'), { recursive: true, force: true });
    unregisterSecret(credentials?.password);
    unregisterSecret(credentials?.username);
  }
}
