'use client';

import { useCallback, useMemo, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Laptop, Loader2, Plug, Server } from 'lucide-react';
import { Field, Modal, inputCls } from '../policies/ui';
import {
  SOURCE_DELETE_POLICIES,
  SOURCE_SCHEDULES,
  type SourceCatalogEntry,
  type SourceCatalogResponse,
  type SourceConnection,
  type SourceContentPolicy,
  type SourceDeletePolicy,
  type SourceSchedule,
} from '../../../lib/contracts/admin-source-connections';
import { PROXY, errorMessage, fill, type ConnectionsT } from './shared';
import { AccountPicker } from './create/AccountPicker';
import { ConnectorFields } from './create/ConnectorFields';
import { DbEntitiesFields } from './create/DbEntitiesFields';
import { FolderPicker } from './create/FolderPicker';
import { RecordsFields, initialRecords, type RecordsChoice } from './create/RecordsFields';
import { RestApiDescribe } from './create/RestApiDescribe';
import { kindTitle } from './KindLabel';
import { cardWords, entriesFor, shapeChoices, type ShapeChoice, type SourceCard } from './kinds';
import {
  AGENT_ID,
  EMPTY_SECRET,
  configFrom,
  credentialFrom,
  dbProposalOf,
  formFor,
  initialValues,
  validate,
  visibleFields,
  type CredentialLabel,
  type FieldError,
  type FormContext,
  type FormValues,
  type OAuthAlternative,
  type SecretValues,
} from './create/specs';

type Step = 'where' | 'source' | 'sync';
const STEPS: Step[] = ['where', 'source', 'sync'];

/**
 * Connecting a source is three questions, asked in order: where it runs
 * (the brain, or an agent on the machine that has it), what exactly to
 * read (the connector's own fields — a folder, a site, a bucket, a
 * server), and how to sync it (schedule, what to take, what to do when
 * an item disappears). Every field is typed and validated; the JSON the
 * brain receives is one click away under Advanced, never the default.
 */
export function ConnectionCreateModal({
  card,
  catalog,
  knownAgents = [],
  t,
  onClose,
  onCreated,
}: {
  card: SourceCard;
  catalog: SourceCatalogResponse;
  /** The agents that have checked in — offered under the agent id field, not required. */
  knownAgents?: string[];
  t: ConnectionsT;
  onClose: () => void;
  /** One connection, or two when the operator wanted documents AND files. */
  onCreated: (created: SourceConnection[]) => void;
}) {
  const f = t.form;
  const choices = useMemo(() => shapeChoices(card), [card]);
  const [shape, setShape] = useState<ShapeChoice | null>(choices.length > 0 ? 'document' : null);
  // The entry the form is built on: same connector for every shape, so the
  // fields are the same; policies are read per entry at submit.
  const entry = useMemo(() => entriesFor(card, shape)[0] ?? card.entries[0]!, [card, shape]);
  const form = useMemo(() => formFor(entry), [entry]);
  const canChoose = entry.hosts.length > 1;
  const [step, setStep] = useState<Step>('where');
  const [host, setHost] = useState<'server' | 'agent'>(entry.hosts[0] ?? 'server');
  const [agentId, setAgentId] = useState('');
  const [label, setLabel] = useState('');
  const [values, setValues] = useState<FormValues>(() => (form ? initialValues(form, entry) : {}));
  const [secret, setSecret] = useState<SecretValues>(EMPTY_SECRET);
  const [records, setRecords] = useState<RecordsChoice>(() => initialRecords(entry));
  const [advanced, setAdvanced] = useState(false);
  const [json, setJson] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [schedule, setSchedule] = useState<SourceSchedule>(entry.defaults.schedule);
  // "Content" is text for a document entry and bytes for a binary one —
  // the operator chooses between taking content and cataloguing only.
  const [take, setTake] = useState<'content' | 'manifest'>(
    entry.defaults.contentPolicy === 'manifest' ? 'manifest' : 'content',
  );
  const [deletePolicy, setDeletePolicy] = useState<SourceDeletePolicy>(entry.defaults.deletePolicy);
  const [fetchBudget, setFetchBudget] = useState('');
  const [ownerUserId, setOwnerUserId] = useState('');
  const [vertical, setVertical] = useState(entry.packId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const ctx: FormContext = useMemo(
    () => ({
      host,
      entry,
      fsRoots: catalog.fsRoots,
      egressAllowPrivate: catalog.egressAllowPrivate,
      ...(host === 'agent' && AGENT_ID.test(agentId.trim()) ? { agentId: agentId.trim() } : {}),
    }),
    [host, entry, catalog, agentId],
  );
  const errors: Record<string, FieldError> = useMemo(
    () => (form && json === null ? validate(form, values, ctx, secret) : {}),
    [form, values, ctx, secret, json],
  );
  const whereOk = host === 'server' || AGENT_ID.test(agentId.trim());
  const sourceOk = Object.keys(errors).length === 0;
  const shownErrors = touched ? errors : {};

  const assembledConfig = useCallback((): Record<string, unknown> => {
    if (json !== null) return JSON.parse(json) as Record<string, unknown>;
    return form ? configFrom(form, values, ctx) : {};
  }, [form, values, ctx, json]);

  const next = useCallback(() => {
    if (step === 'where' && !whereOk) return;
    if (step === 'source' && !sourceOk) {
      setTouched(true);
      return;
    }
    setError(null);
    setStep(STEPS[Math.min(STEPS.indexOf(step) + 1, STEPS.length - 1)] ?? 'sync');
  }, [step, whereOk, sourceOk]);

  const back = useCallback(() => {
    setError(null);
    setStep(STEPS[Math.max(STEPS.indexOf(step) - 1, 0)] ?? 'where');
  }, [step]);

  const submit = useCallback(async () => {
    let config: Record<string, unknown>;
    try {
      config = assembledConfig();
    } catch {
      setError(f.invalidJson);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const targets = entriesFor(card, shape);
      const created: SourceConnection[] = [];
      for (const target of targets) {
        const body: Record<string, unknown> = {
          packId: target.packId,
          sourceId: target.sourceId,
          vertical: vertical.trim() || target.packId,
          // A records connector: the entities chosen and the field → fact table ride the config
          // (a db source's entities are its tables, assembled by the form; the mapping rides the same way).
          config:
            target.connector === 'db'
              ? { ...config, mapping: records.mapping }
              : target.records
                ? {
                    ...config,
                    entities: records.entities,
                    mapping: records.mapping,
                    ...(records.endpoints ? { endpoints: records.endpoints } : {}),
                  }
                : config,
          schedule,
          // "Content" means text for a document entry and bytes for a
          // binary one; "catalogue only" is manifest for both.
          contentPolicy:
            take === 'manifest' ? 'manifest' : target.shape === 'binary' ? 'bytes' : 'text',
          deletePolicy,
          ...(host === 'agent' ? { host: `agent:${agentId.trim()}` } : {}),
        };
        if (label.trim()) {
          body.label =
            targets.length > 1
              ? `${label.trim()} · ${target.shape === 'binary' ? f.shape.binary : f.shape.document}`
              : label.trim();
        }
        const credential = form ? credentialFrom(form, secret) : undefined;
        if (credential) body.credential = credential;
        if (fetchBudget.trim()) body.fetchBudget = Number(fetchBudget);
        if (ownerUserId.trim()) body.ownerUserId = ownerUserId.trim();
        const res = await fetch(PROXY, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const out = await res.json();
        if (!res.ok) throw new Error(errorMessage(out, res.status));
        created.push(out as SourceConnection);
      }
      onCreated(created);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [
    records,
    agentId,
    assembledConfig,
    card,
    deletePolicy,
    f,
    fetchBudget,
    form,
    host,
    label,
    onCreated,
    ownerUserId,
    schedule,
    secret,
    shape,
    take,
    vertical,
  ]);

  const kind = t.kinds[card.family];
  // The same words as the card: the vendor's name, the pack's own line for a vendor or a push door.
  const words = cardWords(card, {
    title: kindTitle(t, card.family, card.connector),
    body: kind.body,
  });
  return (
    <Modal title={fill(t.create.title, { title: words.title })} onClose={onClose} wide>
      <div className="mb-3 text-[11px] text-[var(--text-muted)]">
        {words.body || entry.description}
        <div className="mt-1 font-mono text-[10px] text-[var(--text-faint)]">
          {card.packId} {card.packVersion}
        </div>
      </div>

      <Stepper step={step} t={t} />

      <div className="mt-3 max-h-[60vh] overflow-y-auto pr-1">
        {step === 'where' && (
          <div className="space-y-3">
            {canChoose ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <HostCard
                  icon={<Server className="w-4 h-4" />}
                  title={f.host.serverTitle}
                  body={f.host.serverBody}
                  selected={host === 'server'}
                  onSelect={() => setHost('server')}
                />
                <HostCard
                  icon={<Laptop className="w-4 h-4" />}
                  title={f.host.agentTitle}
                  body={f.host.agentBody}
                  selected={host === 'agent'}
                  onSelect={() => setHost('agent')}
                />
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded border border-[var(--border)] bg-[var(--bg)] p-3 text-xs text-[var(--text)]">
                {host === 'agent' ? (
                  <Laptop className="w-4 h-4 text-[var(--accent)]" />
                ) : (
                  <Server className="w-4 h-4 text-[var(--accent)]" />
                )}
                <span>{host === 'agent' ? f.host.agentOnly : f.host.serverOnly}</span>
              </div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {host === 'agent' && (
                <Field label={`${f.agentId} *`} hint={f.agentIdHint}>
                  <input
                    value={agentId}
                    onChange={(e) => setAgentId(e.target.value)}
                    placeholder={knownAgents[0] ?? 'laptop-1'}
                    autoComplete="off"
                    list={knownAgents.length > 0 ? 'known-agents' : undefined}
                    className={`${inputCls} font-mono`}
                  />
                  {knownAgents.length > 0 && (
                    <datalist id="known-agents">
                      {knownAgents.map((id) => (
                        <option key={id} value={id} />
                      ))}
                    </datalist>
                  )}
                </Field>
              )}
              <Field label={f.label} hint={f.labelHint}>
                <input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  className={inputCls}
                />
              </Field>
            </div>
          </div>
        )}

        {step === 'source' && choices.length > 0 && (
          <div className="mb-4">
            <Cards<ShapeChoice>
              title={t.kinds.whatsInside}
              value={shape ?? 'document'}
              options={choices.map((c) => ({
                value: c,
                title: c === 'both' ? t.kinds.both : kind.shapes[c],
                body:
                  c === 'both'
                    ? t.kinds.bothHint
                    : kind.shapes[c === 'binary' ? 'binaryHint' : 'documentHint'],
              }))}
              onChange={setShape}
              columns={3}
            />
          </div>
        )}
        {step === 'source' && (
          <SourceStep
            entry={entry}
            ctx={ctx}
            form={form}
            values={values}
            errors={shownErrors}
            secret={secret}
            advanced={advanced}
            json={json}
            t={t}
            onValue={(k, v) => setValues((prev) => ({ ...prev, [k]: v }))}
            onBrowse={() => setPicking(true)}
            onSecret={setSecret}
            onAdvanced={setAdvanced}
            onJson={setJson}
            assembledConfig={assembledConfig}
            records={records}
            onRecords={setRecords}
          />
        )}

        {step === 'sync' && (
          <div className="space-y-4">
            <Cards<SourceSchedule>
              title={f.schedule.title}
              value={schedule}
              options={SOURCE_SCHEDULES.map((s) => ({
                value: s,
                title: f.schedule[s].title,
                body: f.schedule[s].body,
              }))}
              onChange={setSchedule}
              columns={5}
            />
            <Cards<'content' | 'manifest'>
              title={f.content.title}
              value={take}
              options={[
                {
                  value: 'content',
                  title: f.content[contentOf(entry)].title,
                  body:
                    shape === 'both'
                      ? `${f.content.text.body} ${f.content.bytes.body}`
                      : f.content[contentOf(entry)].body,
                },
                {
                  value: 'manifest',
                  title: f.content.manifest.title,
                  body: f.content.manifest.body,
                },
              ]}
              onChange={setTake}
              columns={2}
            />
            <Cards<SourceDeletePolicy>
              title={f.onDelete.title}
              value={deletePolicy}
              options={SOURCE_DELETE_POLICIES.map((p) => ({
                value: p,
                title: f.onDelete[p].title,
                body: f.onDelete[p].body,
              }))}
              onChange={setDeletePolicy}
              columns={3}
            />
            <details className="text-xs">
              <summary className="cursor-pointer text-[var(--text-muted)]">{f.advanced}</summary>
              <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-3">
                <Field label={f.fetchBudget} hint={f.fetchBudgetHint}>
                  <input
                    type="number"
                    min={1}
                    value={fetchBudget}
                    onChange={(e) => setFetchBudget(e.target.value)}
                    className={`${inputCls} font-mono`}
                  />
                </Field>
                <Field label={f.ownerUserId} hint={f.ownerUserIdHint}>
                  <input
                    value={ownerUserId}
                    onChange={(e) => setOwnerUserId(e.target.value)}
                    className={`${inputCls} font-mono`}
                  />
                </Field>
                <Field label={f.vertical} hint={f.verticalHint}>
                  <input
                    value={vertical}
                    onChange={(e) => setVertical(e.target.value)}
                    className={`${inputCls} font-mono`}
                  />
                </Field>
              </div>
            </details>
          </div>
        )}
      </div>

      {picking && (
        <FolderPicker
          host={host}
          agentId={agentId.trim()}
          initialRoot={String(values['root'] ?? '')}
          initialInclude={String(values['include'] ?? '')
            .split('\n')
            .map((x) => x.trim())
            .filter(Boolean)}
          t={t}
          onClose={() => setPicking(false)}
          onPick={(root, include) => {
            setValues((prev) => ({ ...prev, root, include: include.join('\n') }));
            setPicking(false);
          }}
        />
      )}

      {error && <div className="mt-3 font-mono text-xs text-[var(--danger)]">{error}</div>}

      <div className="mt-4 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text-muted)]"
        >
          {t.create.cancel}
        </button>
        <div className="flex gap-2">
          {step !== 'where' && (
            <button
              type="button"
              onClick={back}
              className="rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text)] inline-flex items-center gap-1"
            >
              <ChevronLeft className="w-3 h-3" /> {f.back}
            </button>
          )}
          {step !== 'sync' ? (
            <button
              type="button"
              disabled={step === 'where' ? !whereOk : false}
              onClick={next}
              className="rounded bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white inline-flex items-center gap-1 disabled:opacity-40"
            >
              {f.next} <ChevronRight className="w-3 h-3" />
            </button>
          ) : (
            <button
              type="button"
              disabled={busy || !whereOk || !sourceOk}
              onClick={() => void submit()}
              className="rounded bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white inline-flex items-center gap-1 disabled:opacity-40"
            >
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plug className="w-3 h-3" />}
              {busy ? f.connecting : f.connect}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** What "content" means for the entry's shape: text for documents, bytes for files. */
function contentOf(entry: SourceCatalogEntry): SourceContentPolicy {
  return entry.shape === 'binary' ? 'bytes' : 'text';
}

function Stepper({ step, t }: { step: Step; t: ConnectionsT }) {
  const idx = STEPS.indexOf(step);
  return (
    <ol className="flex items-center gap-2 text-[11px]">
      {STEPS.map((s, i) => {
        const done = i < idx;
        const active = i === idx;
        return (
          <li key={s} className="flex items-center gap-2">
            <span
              className={`inline-flex h-5 w-5 items-center justify-center rounded-full font-mono text-[10px] ${
                active
                  ? 'bg-[var(--accent)] text-white'
                  : done
                    ? 'bg-[var(--success)]/20 text-[var(--success)]'
                    : 'bg-[var(--bg-overlay)] text-[var(--text-faint)]'
              }`}
            >
              {done ? <Check className="w-3 h-3" /> : i + 1}
            </span>
            <span className={active ? 'text-[var(--text)]' : 'text-[var(--text-muted)]'}>
              {t.form.steps[s]}
            </span>
            {i < STEPS.length - 1 && <span className="w-6 border-t border-[var(--border)]" />}
          </li>
        );
      })}
    </ol>
  );
}

function HostCard({
  icon,
  title,
  body,
  selected,
  onSelect,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`text-left rounded border p-3 transition-colors ${
        selected
          ? 'border-[var(--accent)] bg-[var(--accent)]/5'
          : 'border-[var(--border)] bg-[var(--bg)] hover:border-[var(--text-faint)]'
      }`}
    >
      <div className="flex items-center gap-2 text-xs font-medium text-[var(--text)]">
        <span className={selected ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}>
          {icon}
        </span>
        {title}
      </div>
      <p className="mt-1 text-[10px] text-[var(--text-muted)]">{body}</p>
    </button>
  );
}

function Cards<T extends string>({
  title,
  value,
  options,
  onChange,
  columns,
}: {
  title: string;
  value: T;
  options: Array<{ value: T; title: string; body: string }>;
  onChange: (v: T) => void;
  columns: number;
}) {
  const cols =
    columns >= 5 ? 'md:grid-cols-5' : columns === 3 ? 'md:grid-cols-3' : 'md:grid-cols-2';
  return (
    <div>
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
        {title}
      </div>
      <div className={`grid grid-cols-1 ${cols} gap-2`}>
        {options.map((o) => {
          const selected = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => onChange(o.value)}
              className={`text-left rounded border p-2 transition-colors ${
                selected
                  ? 'border-[var(--accent)] bg-[var(--accent)]/5'
                  : 'border-[var(--border)] bg-[var(--bg)] hover:border-[var(--text-faint)]'
              }`}
            >
              <div className="text-xs text-[var(--text)]">{o.title}</div>
              {o.body && (
                <div className="mt-0.5 text-[10px] text-[var(--text-muted)]">{o.body}</div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SourceStep({
  entry,
  ctx,
  form,
  values,
  errors,
  secret,
  advanced,
  json,
  t,
  onValue,
  onBrowse,
  onSecret,
  records,
  onRecords,
  onAdvanced,
  onJson,
  assembledConfig,
}: {
  entry: SourceCatalogEntry;
  ctx: FormContext;
  form: ReturnType<typeof formFor>;
  values: FormValues;
  errors: Record<string, FieldError>;
  secret: SecretValues;
  advanced: boolean;
  json: string | null;
  t: ConnectionsT;
  onValue: (key: string, value: string | boolean) => void;
  onBrowse: () => void;
  onSecret: (s: SecretValues) => void;
  records: RecordsChoice;
  onRecords: (r: RecordsChoice) => void;
  onAdvanced: (v: boolean) => void;
  onJson: (v: string | null) => void;
  assembledConfig: () => Record<string, unknown>;
}) {
  const f = t.form;
  if (entry.kind === 'external') {
    return <p className="text-xs text-[var(--text-muted)]">{f.external}</p>;
  }
  if (entry.mcp?.transport === 'stdio') {
    return (
      <div className="text-xs text-[var(--text-muted)]">
        {f.stdio}
        <pre className="mt-1 rounded bg-[var(--bg)] p-2 font-mono text-[11px] text-[var(--text)]">
          {[entry.mcp.command, ...entry.mcp.args].join(' ')}
        </pre>
      </div>
    );
  }
  if (!form) {
    return (
      <JsonEditor
        hint={fill(f.noForm, { connector: entry.connector })}
        value={json ?? JSON.stringify(entry.configExample ?? {}, null, 2)}
        onChange={onJson}
        t={t}
      />
    );
  }
  if (json !== null) {
    return (
      <div className="space-y-2">
        <JsonEditor hint={f.jsonHint} value={json} onChange={onJson} t={t} />
        <button
          type="button"
          onClick={() => onJson(null)}
          className="text-[11px] text-[var(--accent)]"
        >
          {f.editForm}
        </button>
      </div>
    );
  }
  const fields = visibleFields(form, values, ctx, advanced);
  const dbProposal = entry.connector === 'db' ? dbProposalOf(String(values['entities'] ?? '')) : [];
  return (
    <div className="space-y-3">
      {entry.mcp?.transport === 'http' && entry.mcp.url && (
        <Field label={f.pinnedUrl} hint={f.pinnedUrlHint}>
          <input value={entry.mcp.url} readOnly className={`${inputCls} font-mono opacity-70`} />
        </Field>
      )}
      {entry.mcp?.auth === 'install_secret' && (
        <p className="text-[11px] text-[var(--text-muted)]">{f.installSecret}</p>
      )}
      {entry.mcp?.auth === 'oauth' && (
        <p className="text-[11px] text-[var(--text-muted)]">{f.oauth}</p>
      )}
      {entry.connector === 'db' && (
        <DbEntitiesFields
          values={values}
          errors={errors}
          agentId={ctx.agentId ?? ''}
          t={t}
          onChange={onValue}
        />
      )}
      <ConnectorFields
        fields={fields}
        values={values}
        errors={errors}
        ctx={ctx}
        t={t}
        onChange={onValue}
        onBrowse={onBrowse}
      />
      {form.credential?.kind === 'oauth' && entry.oauth && ctx.host === 'server' && (
        <AccountPicker
          entry={entry}
          serverUrl={entry.mcp?.url ?? (typeof values['url'] === 'string' ? values['url'] : '')}
          allowPrivate={values['allowPrivate'] === true}
          value={secret.grantId}
          error={errors['credential'] ? f.errors.account : null}
          t={t}
          onChange={(grantId) => onSecret({ ...secret, grantId })}
        />
      )}
      {form.credential?.kind === 'oauth' &&
        form.credential.alternative &&
        form.credential.alternative !== 'jwtBearer' && (
          <Field
            label={alternativeLabel(f.credential, form.credential.alternative)}
            hint={alternativeHint(f.credential, form.credential.alternative)}
          >
            <input
              type="password"
              value={secret.single}
              onChange={(e) => onSecret({ ...secret, single: e.target.value })}
              autoComplete="new-password"
              className={`${inputCls} font-mono`}
            />
          </Field>
        )}
      {form.credential?.kind === 'oauth' && form.credential.alternative === 'jwtBearer' && (
        <Field label={f.credential.jwtBearer} hint={f.credential.jwtBearerHint}>
          <textarea
            value={secret.single}
            onChange={(e) => onSecret({ ...secret, single: e.target.value })}
            rows={4}
            spellCheck={false}
            placeholder='{ "clientId": "…", "username": "…", "privateKey": "-----BEGIN PRIVATE KEY-----\n…" }'
            className={`${inputCls} font-mono text-[11px]`}
          />
          {errors['credential'] === 'jwtBearer' && (
            <p className="mt-1 text-[11px] text-[var(--danger)]">{f.errors.jwtBearer}</p>
          )}
        </Field>
      )}
      {entry.records && entry.connector === 'rest_records' && (
        <RestApiDescribe
          entry={entry}
          value={records}
          config={assembledConfig()}
          t={t}
          onChange={onRecords}
        />
      )}
      {entry.records && entry.connector === 'db' && dbProposal.length > 0 && (
        <RecordsFields
          entry={entry}
          value={{ ...records, entities: dbProposal.map((e) => e.type), proposal: dbProposal }}
          credential={undefined}
          config={{}}
          previewable={false}
          t={t}
          onChange={onRecords}
        />
      )}
      {entry.records &&
        entry.connector !== 'db' &&
        (entry.records.entities.length > 0 || records.proposal) && (
          <RecordsFields
            entry={entry}
            value={records}
            credential={credentialFrom(form, secret)}
            config={assembledConfig()}
            t={t}
            onChange={onRecords}
          />
        )}
      {form.credential && form.credential.kind !== 'oauth' && form.credential.shown(values) && (
        <CredentialFields
          kind={form.credential.kind}
          label={form.credential.kind === 'single' ? form.credential.label : undefined}
          secret={secret}
          error={errors['credential'] ? f.errors.credential : null}
          t={t}
          onChange={onSecret}
        />
      )}
      <div className="flex items-center gap-3 text-[11px]">
        <button
          type="button"
          onClick={() => onAdvanced(!advanced)}
          className="text-[var(--accent)]"
        >
          {advanced ? f.advancedHide : f.advanced}
        </button>
        <button
          type="button"
          onClick={() => {
            try {
              onJson(JSON.stringify(assembledConfig(), null, 2));
            } catch {
              onJson('{}');
            }
          }}
          className="text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          {f.editJson}
        </button>
      </div>
    </div>
  );
}

function CredentialFields({
  kind,
  label,
  secret,
  error,
  t,
  onChange,
}: {
  kind: 'single' | 'pair';
  label?: CredentialLabel | undefined;
  secret: SecretValues;
  error: string | null;
  t: ConnectionsT;
  onChange: (s: SecretValues) => void;
}) {
  const c = t.form.credential;
  if (kind === 'pair') {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label={c.keyId} hint={error ?? c.pairHint} error={!!error}>
          <input
            value={secret.keyId}
            onChange={(e) => onChange({ ...secret, keyId: e.target.value })}
            autoComplete="off"
            className={`${inputCls} font-mono`}
          />
        </Field>
        <Field label={c.keySecret} hint={c.singleHint}>
          <input
            type="password"
            value={secret.keySecret}
            onChange={(e) => onChange({ ...secret, keySecret: e.target.value })}
            autoComplete="new-password"
            className={`${inputCls} font-mono`}
          />
        </Field>
      </div>
    );
  }
  const named = label ? c[label] : c.single;
  const namedHint = label ? c[`${label}Hint`] : c.singleHint;
  return (
    <Field label={named} hint={error ?? namedHint} error={!!error}>
      <input
        type="password"
        value={secret.single}
        onChange={(e) => onChange({ ...secret, single: e.target.value })}
        autoComplete="new-password"
        className={`${inputCls} font-mono`}
      />
    </Field>
  );
}

function JsonEditor({
  hint,
  value,
  onChange,
  t,
}: {
  hint: string;
  value: string;
  onChange: (v: string) => void;
  t: ConnectionsT;
}) {
  let invalid = false;
  try {
    JSON.parse(value);
  } catch {
    invalid = true;
  }
  return (
    <Field label="config" hint={invalid ? t.form.invalidJson : hint} error={invalid}>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={8}
        spellCheck={false}
        className={`${inputCls} font-mono`}
      />
    </Field>
  );
}

/** "or an API token" / "or an inbound webhook URL" / "or a long-lived token" — the alternative to a connected account, by its kind. */
function alternativeLabel(c: ConnectionsT['form']['credential'], alt: OAuthAlternative): string {
  if (alt === 'webhookUrl') return c.webhookUrlAlt;
  if (alt === 'longLivedToken') return c.longLivedTokenAlt;
  if (alt === 'botToken') return c.botTokenAlt;
  return c.token;
}

function alternativeHint(c: ConnectionsT['form']['credential'], alt: OAuthAlternative): string {
  if (alt === 'webhookUrl') return c.webhookUrlHint;
  if (alt === 'longLivedToken') return c.longLivedTokenHint;
  if (alt === 'botToken') return c.botTokenAltHint;
  return c.tokenHint;
}
