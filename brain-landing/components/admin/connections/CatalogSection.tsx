'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Plug } from 'lucide-react'
import type { SourceCatalogResponse } from '../../../lib/contracts/admin-source-connections'
import { GROUP_ICONS, GroupHeading, KIND_ICONS, kindTitle } from './KindLabel'
import {
  cardWords,
  cardsOf,
  groupCards,
  isTextShape,
  type SourceCard,
  type SourceGroup,
} from './kinds'
import { accentBtn, availabilityTone, fill, shapeWords, type ConnectionsT } from './shared'

/**
 * The catalogue of what this tenant could connect — every pack's
 * declared `sources` folded to one card per kind, laid out by group
 * (files, web, MCP servers, code, records, pushed) so seventeen cards
 * read as six shelves. The chips narrow to one group; the deployment
 * fences a connection has to fit inside sit folded underneath.
 */
export function CatalogSection({
  catalog,
  t,
  lang,
  onConnect,
}: {
  catalog: SourceCatalogResponse
  t: ConnectionsT
  lang: string
  onConnect: (card: SourceCard) => void
}) {
  const [only, setOnly] = useState<SourceGroup | null>(null)
  const groups = useMemo(() => groupCards(cardsOf(catalog.sources)), [catalog.sources])
  const total = groups.reduce((n, g) => n + g.items.length, 0)
  const shown = only ? groups.filter((g) => g.group === only) : groups
  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-medium text-[var(--text)]">{t.catalog.title}</h2>
          <p className="text-[11px] text-[var(--text-muted)] max-w-3xl">{t.catalog.subtitle}</p>
        </div>
        {groups.length > 1 && (
          <div className="flex flex-wrap gap-1" role="group" aria-label={t.catalog.title}>
            <Chip active={only === null} onClick={() => setOnly(null)} label={t.catalog.all} count={total} />
            {groups.map((g) => {
              const Icon = GROUP_ICONS[g.group]
              return (
                <Chip
                  key={g.group}
                  active={only === g.group}
                  onClick={() => setOnly(only === g.group ? null : g.group)}
                  label={t.groups[g.group].title}
                  count={g.items.length}
                  icon={<Icon className="w-3 h-3" />}
                />
              )
            })}
          </div>
        )}
      </div>

      {total === 0 ? (
        <p className="rounded-md border border-[var(--border)] px-3 py-4 text-center text-xs text-[var(--text-muted)] italic">
          {t.catalog.empty}
        </p>
      ) : (
        shown.map((g) => (
          <section key={g.group} className="space-y-2">
            <div>
              <GroupHeading group={g.group} count={g.items.length} t={t} />
              <p className="text-[11px] text-[var(--text-muted)] max-w-3xl">{t.groups[g.group].body}</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {g.items.map((card) => (
                <SourceKindCard key={card.key} card={card} t={t} lang={lang} onConnect={() => onConnect(card)} />
              ))}
            </div>
          </section>
        ))
      )}

      <details className="text-xs">
        <summary className="cursor-pointer text-[var(--text-muted)]">{t.kinds.deployment}</summary>
        <div className="mt-2">
          <Fences catalog={catalog} t={t} />
        </div>
      </details>
    </div>
  )
}

function Chip({
  active,
  onClick,
  label,
  count,
  icon,
}: {
  active: boolean
  onClick: () => void
  label: string
  count: number
  icon?: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`px-2 py-0.5 rounded-full text-[10px] inline-flex items-center gap-1 border ${
        active
          ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
          : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]'
      }`}
    >
      {icon}
      {label}
      <span className="font-mono text-[var(--text-faint)]">{count}</span>
    </button>
  )
}

/**
 * One kind of thing the packs here can read — a folder, a site, a
 * bucket, an MCP server, a repository — with what it is in plain words,
 * whether it can be connected right now (and what to do if not), and
 * the pack behind it in small print.
 */
function SourceKindCard({
  card,
  t,
  lang,
  onConnect,
}: {
  card: SourceCard
  t: ConnectionsT
  lang: string
  onConnect: () => void
}) {
  const k = t.kinds
  const Icon = KIND_ICONS[card.family]
  const flag = `SOURCE_KIND_${card.connector.toUpperCase()}`
  const status = card.accepted ? card.availability : 'notAccepted'
  const connectable = card.accepted && card.availability !== 'missing'
  const oauth = card.entries[0]?.oauth ?? null
  const hint =
    status === 'ready' && oauth && !oauth.configured
      ? fill(k.statusHint.oauthUnconfigured, {
          provider: oauth.title,
          flag: `SOURCE_OAUTH_${oauth.provider.toUpperCase()}_CLIENT_ID`,
        })
      : fill(k.statusHint[status], { flag })
  const shapes = [...new Set(card.entries.map((e) => e.shape))]
  const words = cardWords(card, {
    title: kindTitle(t, card.family, card.connector),
    body: k[card.family].body,
  })
  return (
    <article
      className={`flex flex-col rounded-md border p-3 ${
        connectable ? 'border-[var(--border)] bg-[var(--bg-elevated)]' : 'border-[var(--border)] bg-[var(--bg)] opacity-80'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded bg-[var(--accent)]/10 text-[var(--accent)]">
            <Icon className="w-4 h-4" />
          </span>
          <div>
            <h3 className="text-sm font-medium text-[var(--text)]">
              {words.title}
              {card.ambiguous && (
                <span className="ml-1 text-[10px] font-normal text-[var(--text-faint)]">
                  {fill(k.viaPack, { packId: card.packId })}
                </span>
              )}
            </h3>
            <div className="text-[10px] text-[var(--text-faint)]">
              {shapes
                .filter((sh) => isTextShape(sh) || sh === 'binary')
                .map((sh) => shapeWords(k[card.family].shapes, sh as 'document' | 'conversation' | 'binary').title)
                .filter((w) => w.length > 0)
                .join(' · ')}
            </div>
          </div>
        </div>
        <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] ${availabilityTone(status === 'notAccepted' ? 'disabled' : status)}`} title={hint || undefined}>
          {k.status[status]}
        </span>
      </div>
      <p className="mt-2 text-[11px] text-[var(--text-muted)] flex-1">{words.body}</p>
      {hint && (
        <p className="mt-1 text-[10px] text-[var(--warning)]">
          {hint}
          {status === 'notAccepted' && (
            <>
              {' '}
              <Link href={`/${lang}/admin/packs`} className="underline">
                {t.catalog.reinstall}
              </Link>
            </>
          )}
        </p>
      )}
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] text-[var(--text-faint)]" title={card.entries.map((e) => e.sourceId).join(', ')}>
          {card.packId}
          {' '}
          {card.packVersion}
          {card.builtin ? ` · ${t.catalog.builtin}` : ''}
        </span>
        <button type="button" disabled={!connectable} onClick={onConnect} className={accentBtn}>
          <Plug className="w-3 h-3" /> {k.connect}
        </button>
      </div>
    </article>
  )
}

function Fences({
  catalog,
  t,
}: {
  catalog: SourceCatalogResponse
  t: ConnectionsT
}) {
  const f = t.fences
  return (
    <article className="p-3 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)]">
      <h2 className="text-xs font-semibold text-[var(--text)] mb-2">
        {f.title}
      </h2>
      <dl className="grid grid-cols-1 md:grid-cols-[8rem_1fr] gap-x-4 gap-y-1.5 text-[11px]">
        <dt className="text-[var(--text-muted)]">{f.connectors}</dt>
        <dd className="flex flex-wrap gap-1.5">
          {catalog.connectors.map((c) => (
            <span
              key={c.kind}
              className={`px-1.5 py-0.5 rounded font-mono text-[10px] ${
                c.state === 'ready'
                  ? 'text-[var(--success)] bg-[var(--success)]/10'
                  : 'text-[var(--warning)] bg-[var(--warning)]/10'
              }`}
              title={c.state === 'ready' ? c.flag : fill(f.connectorOff, { flag: c.flag })}
            >
              {c.kind}
              {c.state === 'disabled' && ` — ${fill(f.connectorOff, { flag: c.flag })}`}
            </span>
          ))}
        </dd>
        <dt className="text-[var(--text-muted)]">{f.fsRoots}</dt>
        <dd className="font-mono text-[var(--text)]">
          {catalog.fsRoots.length === 0 ? (
            <span className="text-[var(--text-faint)]">{f.fsRootsNone}</span>
          ) : (
            catalog.fsRoots.join(', ')
          )}
        </dd>
        <dt className="text-[var(--text-muted)]">{f.egress}</dt>
        <dd className={catalog.egressAllowPrivate ? 'text-[var(--warning)]' : 'text-[var(--text)]'}>
          {catalog.egressAllowPrivate ? f.egressOn : f.egressOff}
        </dd>
      </dl>
    </article>
  )
}
