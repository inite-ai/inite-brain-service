'use client'

import { useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Languages,
  Quote,
  ShieldAlert,
  XCircle,
} from 'lucide-react'

interface QueryRunResult {
  query: string
  expectedTopEntityRef: string
  rankOfExpected: number
  topEntityRef: string | null
  factPredicateMatched: boolean | null
  asOf?: string
  durationMs: number
  hitCount: number
  topHits: Array<{
    entityId: string
    canonicalName: string
    score: number
    externalRefs: Record<string, string>
  }>
  passed: boolean
  piiGatedCorrectly: boolean | null
  mustNotLeakPredicate?: string
  error?: string
}

interface MemoryAssertionResult {
  description: string
  kind: 'no_search_match' | 'search_object_present' | 'search_object_absent'
  passed: boolean
  detail?: string
  durationMs: number
}

interface IdentityMergeOutcomeShape {
  survivorRef: string
  loserRef: string
  merged: boolean
  falseMerges: string[]
  unresolvedDistractors: string[]
  detail?: string
}

interface SynthesizeOutcomeShape {
  scenarioId: string
  query: string
  answer: string | null
  reason?: string
  faithfulness: number | null
  totalClaims: number
  verifierFailureKind?: 'length_mismatch' | 'invalid_verdicts' | 'exception'
  passed: boolean
  faithfulnessFloor: number
  answerLangDetected?: string | null
  answerLangCorrect?: boolean
  decisionLogCitationCount?: number
  avgExtractionEntropy?: number | null
}

export interface ScenarioRunOutcome {
  scenarioId: string
  vertical: string
  companyId: string
  startedAt: string
  durationMs: number
  passed: boolean
  setupSummary: {
    facts: number
    mentions: number
    links: number
    retracts: number
    forgets: number
    errors: Array<{ step: number; kind: string; error: string }>
  }
  queryResults: QueryRunResult[]
  memoryAssertionResults: MemoryAssertionResult[]
  identityMergeResult?: IdentityMergeOutcomeShape
  synthesizeSkipped?: { count: number; reason: string }
  synthesizeOutcomes?: SynthesizeOutcomeShape[]
  metrics: {
    recallAt1: number
    recallAt5: number
    queries: number
    passes: number
    memoryAssertionsPassed: number
    memoryAssertionsTotal: number
    piiGatingPassed: number
    piiGatingTotal: number
  }
}

export function ScenarioRunResultView({
  outcome,
}: {
  outcome: ScenarioRunOutcome
}) {
  return (
    <div className="space-y-3">
      <div className="border border-[var(--border)] rounded-md p-3">
        <div className="flex items-center gap-2">
          {outcome.passed ? (
            <CheckCircle2 className="w-4 h-4 text-[var(--accent)]" />
          ) : (
            <XCircle className="w-4 h-4 text-[var(--danger)]" />
          )}
          <span className="font-medium text-[var(--text)]">
            {outcome.passed ? 'passed' : 'failed'}
          </span>
          <span className="text-xs text-[var(--text-faint)]">
            {outcome.durationMs}ms · {outcome.companyId}
          </span>
        </div>
        <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
          <Metric label="recall@1" value={outcome.metrics.recallAt1} />
          <Metric label="recall@5" value={outcome.metrics.recallAt5} />
          <Metric
            label="queries"
            value={`${outcome.metrics.passes}/${outcome.metrics.queries}`}
          />
          {outcome.metrics.memoryAssertionsTotal > 0 && (
            <Metric
              label="mem-assert"
              value={`${outcome.metrics.memoryAssertionsPassed}/${outcome.metrics.memoryAssertionsTotal}`}
            />
          )}
          {outcome.metrics.piiGatingTotal > 0 && (
            <Metric
              label="pii-gating"
              value={`${outcome.metrics.piiGatingPassed}/${outcome.metrics.piiGatingTotal}`}
            />
          )}
        </div>
        <div className="mt-2 text-xs text-[var(--text-faint)]">
          setup: {outcome.setupSummary.facts} facts ·{' '}
          {outcome.setupSummary.mentions} mentions ·{' '}
          {outcome.setupSummary.links} links ·{' '}
          {outcome.setupSummary.retracts} retracts ·{' '}
          {outcome.setupSummary.forgets} forgets
          {outcome.setupSummary.errors.length > 0 && (
            <span className="text-[var(--danger)] ml-2">
              {outcome.setupSummary.errors.length} errors
            </span>
          )}
        </div>
        {outcome.setupSummary.errors.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-[10px] font-mono text-[var(--danger)]">
            {outcome.setupSummary.errors.map((e, i) => (
              <li key={i}>
                step {e.step} ({e.kind}): {e.error}
              </li>
            ))}
          </ul>
        )}
      </div>

      {outcome.identityMergeResult && (
        <IdentityMergeSection im={outcome.identityMergeResult} />
      )}

      {outcome.memoryAssertionResults.length > 0 && (
        <div>
          <h3 className="text-xs uppercase tracking-wider text-[var(--text-faint)] mb-1">
            Memory assertions
          </h3>
          <ul className="space-y-1">
            {outcome.memoryAssertionResults.map((a, i) => (
              <MemoryAssertionRow key={i} a={a} />
            ))}
          </ul>
        </div>
      )}

      <div>
        <h3 className="text-xs uppercase tracking-wider text-[var(--text-faint)] mb-1">
          Queries
        </h3>
        <ul className="space-y-1">
          {outcome.queryResults.map((q, i) => (
            <QueryRow key={i} q={q} />
          ))}
        </ul>
      </div>

      {outcome.synthesizeSkipped && (
        <div className="border border-[var(--warning)]/40 bg-[var(--warning)]/5 rounded-md p-2 flex gap-2 items-start text-xs">
          <AlertTriangle className="w-4 h-4 text-[var(--warning)] shrink-0 mt-0.5" />
          <div>
            <div className="text-[var(--text)]">
              synthesize: skipped ({outcome.synthesizeSkipped.count}{' '}
              {outcome.synthesizeSkipped.count === 1 ? 'query' : 'queries'})
            </div>
            <div className="text-[var(--text-muted)] mt-0.5">
              {outcome.synthesizeSkipped.reason}
            </div>
          </div>
        </div>
      )}

      {outcome.synthesizeOutcomes && outcome.synthesizeOutcomes.length > 0 && (
        <SynthesizeSection outcomes={outcome.synthesizeOutcomes} />
      )}
    </div>
  )
}

function SynthesizeSection({
  outcomes,
}: {
  outcomes: SynthesizeOutcomeShape[]
}) {
  const meanFaith =
    outcomes
      .filter((o) => typeof o.faithfulness === 'number')
      .reduce((a, o) => a + (o.faithfulness ?? 0), 0) /
    Math.max(1, outcomes.filter((o) => typeof o.faithfulness === 'number').length)
  const langChecked = outcomes.filter((o) => o.answerLangCorrect !== undefined)
  const langOk = langChecked.filter((o) => o.answerLangCorrect === true).length
  const cited = outcomes.filter(
    (o) => (o.decisionLogCitationCount ?? 0) > 0 && o.answer !== null,
  ).length
  const withAnswer = outcomes.filter((o) => o.answer !== null).length
  const entropyVals = outcomes
    .map((o) => o.avgExtractionEntropy)
    .filter((v): v is number => typeof v === 'number')
  const meanEntropy =
    entropyVals.length === 0
      ? null
      : entropyVals.reduce((a, b) => a + b, 0) / entropyVals.length
  return (
    <div>
      <h3 className="text-xs uppercase tracking-wider text-[var(--text-faint)] mb-1">
        Synthesize ({outcomes.length})
      </h3>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs mb-2">
        <Metric label="mean faithfulness" value={meanFaith} />
        {langChecked.length > 0 && (
          <Metric
            label="answer-lang ok"
            value={`${langOk}/${langChecked.length}`}
          />
        )}
        {withAnswer > 0 && (
          <Metric label="cited" value={`${cited}/${withAnswer}`} />
        )}
        {meanEntropy !== null && (
          <Metric
            label="mean extraction H"
            value={meanEntropy.toFixed(3)}
          />
        )}
      </div>
      <ul className="space-y-1">
        {outcomes.map((s, i) => (
          <SynthesizeRow key={i} s={s} />
        ))}
      </ul>
    </div>
  )
}

function SynthesizeRow({ s }: { s: SynthesizeOutcomeShape }) {
  const [open, setOpen] = useState(false)
  const faithBad =
    typeof s.faithfulness === 'number' &&
    s.faithfulness < s.faithfulnessFloor
  return (
    <li
      className={`border rounded-md p-2 ${
        s.passed
          ? 'border-[var(--border)]'
          : 'border-[var(--danger)]/40 bg-[var(--danger)]/5'
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 text-left"
      >
        <ChevronRight
          className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        {s.passed ? (
          <CheckCircle2 className="w-3.5 h-3.5 text-[var(--accent)]" />
        ) : (
          <XCircle className="w-3.5 h-3.5 text-[var(--danger)]" />
        )}
        <span className="text-sm text-[var(--text)] truncate">{s.query}</span>
        {s.answerLangCorrect === false && (
          <Languages
            className="w-3.5 h-3.5 text-[var(--danger)]"
            aria-label="wrong language"
          />
        )}
        {s.answer !== null && (s.decisionLogCitationCount ?? 0) === 0 && (
          <Quote
            className="w-3.5 h-3.5 text-[var(--warning)]"
            aria-label="no citations"
          />
        )}
        <span className="ml-auto text-xs text-[var(--text-faint)] flex items-center gap-2">
          {typeof s.faithfulness === 'number' && (
            <span
              className={
                faithBad
                  ? 'text-[var(--danger)] font-mono'
                  : 'text-[var(--text-muted)] font-mono'
              }
            >
              faith {s.faithfulness.toFixed(2)}/{s.faithfulnessFloor.toFixed(2)}
            </span>
          )}
        </span>
      </button>
      {open && (
        <div className="mt-2 ml-5 text-xs space-y-1.5">
          {s.answer ? (
            <div className="text-[var(--text-muted)]">
              <span className="text-[10px] text-[var(--text-faint)] uppercase">
                answer
              </span>
              <div className="mt-0.5 p-2 rounded bg-[var(--bg)] border border-[var(--border)] text-[var(--text)] whitespace-pre-wrap">
                {s.answer}
              </div>
            </div>
          ) : (
            <div className="text-[var(--text-faint)]">
              no answer (
              {s.reason ?? 'unspecified'})
            </div>
          )}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[10px] font-mono">
            <Cell label="claims" value={s.totalClaims.toString()} />
            <Cell
              label="floor"
              value={s.faithfulnessFloor.toFixed(2)}
            />
            {s.answerLangDetected && (
              <Cell label="lang" value={s.answerLangDetected} />
            )}
            {typeof s.decisionLogCitationCount === 'number' && (
              <Cell
                label="citations"
                value={s.decisionLogCitationCount.toString()}
              />
            )}
            {typeof s.avgExtractionEntropy === 'number' && (
              <Cell
                label="extraction H"
                value={s.avgExtractionEntropy.toFixed(3)}
              />
            )}
            {s.verifierFailureKind && (
              <Cell
                label="verifier"
                value={s.verifierFailureKind}
                tone="danger"
              />
            )}
          </div>
        </div>
      )}
    </li>
  )
}

function Cell({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'danger'
}) {
  return (
    <div>
      <div className="text-[10px] text-[var(--text-faint)] uppercase tracking-wider">
        {label}
      </div>
      <div
        className={
          tone === 'danger'
            ? 'text-[var(--danger)]'
            : 'text-[var(--text)]'
        }
      >
        {value}
      </div>
    </div>
  )
}

function IdentityMergeSection({ im }: { im: IdentityMergeOutcomeShape }) {
  const ok =
    im.merged &&
    im.falseMerges.length === 0 &&
    im.unresolvedDistractors.length === 0
  return (
    <div
      className={`border rounded-md p-2 ${
        ok
          ? 'border-[var(--border)]'
          : 'border-[var(--danger)]/40 bg-[var(--danger)]/5'
      }`}
    >
      <div className="flex items-center gap-2 text-xs">
        {ok ? (
          <CheckCircle2 className="w-3.5 h-3.5 text-[var(--accent)]" />
        ) : (
          <XCircle className="w-3.5 h-3.5 text-[var(--danger)]" />
        )}
        <span className="text-[var(--text)]">identity merge</span>
        <span className="font-mono text-[var(--text-muted)]">
          {im.survivorRef} ⇐ {im.loserRef}
        </span>
        <span className="ml-auto text-[10px] text-[var(--text-faint)]">
          merged={String(im.merged)}
        </span>
      </div>
      {im.detail && (
        <div className="text-[10px] text-[var(--text-muted)] mt-1">
          {im.detail}
        </div>
      )}
      {im.falseMerges.length > 0 && (
        <div className="text-[10px] text-[var(--danger)] mt-1 font-mono">
          false-merges: {im.falseMerges.join(', ')}
        </div>
      )}
      {im.unresolvedDistractors.length > 0 && (
        <div className="text-[10px] text-[var(--warning)] mt-1 font-mono">
          unresolved distractors: {im.unresolvedDistractors.join(', ')}
        </div>
      )}
    </div>
  )
}

function MemoryAssertionRow({ a }: { a: MemoryAssertionResult }) {
  return (
    <li
      className={`border rounded-md p-2 flex items-start gap-2 text-xs ${
        a.passed
          ? 'border-[var(--border)]'
          : 'border-[var(--danger)]/40 bg-[var(--danger)]/5'
      }`}
    >
      {a.passed ? (
        <CheckCircle2 className="w-3.5 h-3.5 text-[var(--accent)] mt-0.5 shrink-0" />
      ) : (
        <XCircle className="w-3.5 h-3.5 text-[var(--danger)] mt-0.5 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[var(--text)]">{a.description}</div>
        <div className="text-[10px] text-[var(--text-faint)] mt-0.5 font-mono">
          {a.kind} · {a.durationMs}ms
        </div>
        {a.detail && !a.passed && (
          <div className="text-[10px] text-[var(--text-muted)] mt-1">
            {a.detail}
          </div>
        )}
      </div>
    </li>
  )
}

function Metric({
  label,
  value,
}: {
  label: string
  value: number | string
}) {
  return (
    <div>
      <div className="text-[10px] text-[var(--text-faint)] uppercase tracking-wider">
        {label}
      </div>
      <div className="font-mono text-[var(--text)]">
        {typeof value === 'number' ? value.toFixed(2) : value}
      </div>
    </div>
  )
}

function QueryRow({ q }: { q: QueryRunResult }) {
  const [open, setOpen] = useState(false)
  return (
    <li
      className={`border rounded-md p-2 ${
        q.passed
          ? 'border-[var(--border)]'
          : 'border-[var(--danger)]/40 bg-[var(--danger)]/5'
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 text-left"
      >
        <ChevronRight
          className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        {q.passed ? (
          <CheckCircle2 className="w-3.5 h-3.5 text-[var(--accent)]" />
        ) : (
          <XCircle className="w-3.5 h-3.5 text-[var(--danger)]" />
        )}
        <span className="text-sm text-[var(--text)] truncate">{q.query}</span>
        {q.mustNotLeakPredicate && (
          <ShieldAlert
            className={`w-3.5 h-3.5 shrink-0 ${
              q.piiGatedCorrectly
                ? 'text-[var(--accent)]'
                : 'text-[var(--danger)]'
            }`}
          />
        )}
        <span className="ml-auto text-xs text-[var(--text-faint)]">
          rank {q.rankOfExpected === 0 ? '∞' : q.rankOfExpected} · {q.durationMs}ms
        </span>
      </button>
      {open && (
        <div className="mt-2 ml-5 text-xs space-y-1">
          <div className="text-[var(--text-muted)]">
            expected{' '}
            <span className="font-mono text-[var(--text)]">
              {q.expectedTopEntityRef}
            </span>{' '}
            · got{' '}
            <span className="font-mono text-[var(--text)]">
              {q.topEntityRef ?? '—'}
            </span>
          </div>
          {q.asOf && (
            <div className="text-[var(--text-faint)]">asOf {q.asOf}</div>
          )}
          {q.error && (
            <div className="text-[var(--danger)] font-mono">
              error: {q.error}
            </div>
          )}
          {q.factPredicateMatched !== null && (
            <div className="text-[var(--text-muted)]">
              factPredicateMatched:{' '}
              <span
                className={
                  q.factPredicateMatched
                    ? 'text-[var(--accent)]'
                    : 'text-[var(--danger)]'
                }
              >
                {String(q.factPredicateMatched)}
              </span>
            </div>
          )}
          {q.mustNotLeakPredicate && (
            <div className="text-[var(--text-muted)]">
              piiGated (must not leak{' '}
              <span className="font-mono">{q.mustNotLeakPredicate}</span>):{' '}
              <span
                className={
                  q.piiGatedCorrectly
                    ? 'text-[var(--accent)]'
                    : 'text-[var(--danger)]'
                }
              >
                {String(q.piiGatedCorrectly)}
              </span>
            </div>
          )}
          <div className="mt-1">
            <div className="text-[10px] text-[var(--text-faint)] uppercase tracking-wider">
              top hits
            </div>
            <ul className="space-y-0.5">
              {q.topHits.map((h, i) => (
                <li
                  key={h.entityId}
                  className="text-xs flex items-baseline gap-2"
                >
                  <span className="font-mono w-5 text-[var(--text-faint)]">
                    #{i + 1}
                  </span>
                  <span className="text-[var(--text)] truncate flex-1">
                    {h.canonicalName}
                  </span>
                  <span className="font-mono text-[10px] text-[var(--accent)]">
                    {h.score.toFixed(3)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </li>
  )
}
