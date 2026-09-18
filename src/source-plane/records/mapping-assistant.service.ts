import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type OpenAI from 'openai';
import { DEFAULT_JUDGE_MODEL } from '../../ai/entity-judge.service';
import { chatCallParams, createOpenAiClient } from '../../ai/openai-client';
import { withGenAiCall } from '../../common/gen-ai-observability';
import { sourceMappingAssistantEnabled } from '../../common/source-plane-flags';
import {
  RestEntitySchema,
  type MappingAssistRequest,
  type MappingAssistResponse,
  type RestEntity,
} from '../../contracts/source-plane/source-plane.schema';
import { MetricsService } from '../../metrics/metrics.service';
import { safeFetch } from '../connectors/safe-fetch';
import {
  coreTypeOf,
  proposeFromOperations,
  proposeFromSample,
  proposeMapping,
  type EntityProposal,
} from './mapping-heuristics';
import { digestOpenApi, parseOpenApiText, type ApiDigest } from './openapi-digest';
import type { EntityMapping, RecordMapping, Vocabulary } from './record-mapping';
import { RecordsDoorService } from './records-door.service';

/**
 * MappingAssistantService — "the brain proposes the mapping, the preview
 * is the truth" (docs/roadmap/crm-sources-2026-09.md § 4.3). From an
 * OpenAPI document (fetched through the egress guard, or pasted) and /
 * or sample list answers, propose the `rest_records` config for a
 * backend that has no connector of its own: which operations are
 * entity lists, the entity type in the brain's vocabulary, the id /
 * name / updated-at fields, the paging style and its parameters, the
 * incremental filter, the relation fields, and the field → predicate
 * mapping over the pack's vocabulary — each entity with a reason and a
 * confidence.
 *
 * Two layers: the deterministic heuristics (always; free; in process)
 * and, under SOURCE_MAPPING_ASSISTANT with a key, one bounded model
 * call that refines them under a strict JSON schema — validated the
 * same way the operator's own config is, so a hallucinated field is
 * dropped, never trusted. Nothing here writes: the proposal is what the
 * operator edits, previews and only then connects.
 */

const OPENAPI_MAX_BYTES = 2 * 1024 * 1024;
const OPENAPI_TIMEOUT_MS = 20_000;
/** What the model sees at most (the digest is already bounded per operation). */
const MODEL_MAX_OPERATIONS = 40;
const MODEL_MAX_PROPERTIES = 40;

interface ModelEntity {
  type: string;
  label: string | null;
  list: { path: string; method: 'GET' | 'POST' | null };
  items: string | null;
  get: string | null;
  paging: {
    style: 'none' | 'page' | 'offset' | 'cursor' | 'link';
    param: string | null;
    sizeParam: string | null;
    size: number | null;
    next: string | null;
  } | null;
  incremental: {
    param: string;
    format: 'iso' | 'epoch' | 'epoch_ms' | 'date' | null;
    in: 'query' | 'body' | null;
  } | null;
  fields: { id: string; name: string[]; updatedAt: string | null };
  relations: Array<{ kind: string; targetType: string; path: string; name: string | null }>;
  deleted: string | null;
  mapping: Array<{ field: string; predicate: string }>;
  confidence: number;
  reason: string;
}

@Injectable()
export class MappingAssistantService {
  private readonly logger = new Logger(MappingAssistantService.name);
  private readonly openai: OpenAI | null;
  private readonly model: string;

  constructor(
    private readonly door: RecordsDoorService,
    private readonly config: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.openai = createOpenAiClient(this.config);
    this.model = this.config.get<string>('MAPPING_ASSISTANT_MODEL', DEFAULT_JUDGE_MODEL);
  }

  async assist(companyId: string, req: MappingAssistRequest): Promise<MappingAssistResponse> {
    const vocab = await this.door.vocabularyFor(companyId, req.packId);
    if (!vocab) throw new BadRequestException(`pack "${req.packId}" is not installed here`);
    if (!req.openapi?.url && !req.openapi?.text && !req.samples?.length) {
      throw new BadRequestException(
        'give an OpenAPI document (url or text) or at least one sample',
      );
    }
    const warnings: string[] = [];
    const digest = await this.digestOf(req, warnings);
    const proposals = proposalsOf(digest, req.samples ?? [], warnings);
    const mappings = new Map<string, EntityMapping>();
    for (const p of proposals.values())
      mappings.set(p.type, proposeMapping(p.type, p.attributeKeys, vocab));
    const refined = await this.maybeRefine({ digest, proposals, mappings, vocab, warnings });
    return { ...assemble(req, proposals, mappings), refined, warnings };
  }

  private async digestOf(req: MappingAssistRequest, warnings: string[]): Promise<ApiDigest | null> {
    if (!req.openapi?.url && !req.openapi?.text) return null;
    const text = req.openapi.text ?? (await this.fetchOpenApi(req.openapi.url!, req.allowPrivate));
    const digest = digestOpenApi(parseOpenApiText(text));
    if (digest.operations.length === 0) {
      warnings.push('the OpenAPI document declares no list-shaped read operation');
    }
    return digest;
  }

  /** The model pass, when the operator enabled it and a key exists; any failure is a warning, never an error. */
  private async maybeRefine(p: {
    digest: ApiDigest | null;
    proposals: Map<string, EntityProposal>;
    mappings: Map<string, EntityMapping>;
    vocab: Vocabulary;
    warnings: string[];
  }): Promise<boolean> {
    if (p.proposals.size === 0 || !sourceMappingAssistantEnabled()) return false;
    if (!this.openai) {
      p.warnings.push(
        'SOURCE_MAPPING_ASSISTANT is on but no OPENAI_API_KEY is set — heuristics only',
      );
      return false;
    }
    try {
      return await this.refine(p);
    } catch (e) {
      this.logger.warn(`mapping assistant model call failed: ${(e as Error).message}`);
      p.warnings.push(`the model did not answer (${(e as Error).message}) — heuristics only`);
      return false;
    }
  }

  private async fetchOpenApi(url: string, allowPrivate: boolean | undefined): Promise<string> {
    let res;
    try {
      res = await safeFetch(url, {
        method: 'GET',
        headers: { accept: 'application/json, application/yaml, text/yaml, */*' },
        allowPrivate,
        maxBytes: OPENAPI_MAX_BYTES,
        timeoutMs: OPENAPI_TIMEOUT_MS,
      });
    } catch (e) {
      throw new BadRequestException(
        `the OpenAPI document could not be fetched: ${(e as Error).message}`,
      );
    }
    if (res.status < 200 || res.status >= 300) {
      throw new BadRequestException(`the OpenAPI document answered HTTP ${res.status}`);
    }
    return res.body.toString('utf8');
  }

  /** One strict-schema model call over the digest + the heuristic proposal; validated entries replace the heuristic ones. */
  private async refine(p: {
    digest: ApiDigest | null;
    proposals: Map<string, EntityProposal>;
    mappings: Map<string, EntityMapping>;
    vocab: Vocabulary;
  }): Promise<boolean> {
    const openai = this.openai!;
    const predicates = [...new Set([...p.vocab.localIds, ...p.vocab.corePredicates])].sort();
    const input = {
      api: p.digest
        ? {
            title: p.digest.title,
            operations: p.digest.operations.slice(0, MODEL_MAX_OPERATIONS).map((o) => ({
              method: o.method,
              path: o.path,
              summary: o.summary,
              params: o.params.map((x) => `${x.in}:${x.name}${x.type ? `:${x.type}` : ''}`),
              itemsPath: o.itemsPath,
              answerKeys: o.answerKeys,
              rowProperties: o.properties
                .slice(0, MODEL_MAX_PROPERTIES)
                .map((x) => (x.type ? `${x.name}:${x.type}` : x.name)),
            })),
          }
        : null,
      heuristicProposal: [...p.proposals.values()].map((e) => ({
        type: e.type,
        source: e.source,
        endpoint: e.endpoint,
        attributeKeys: e.attributeKeys,
        mapping: p.mappings.get(e.type)?.fields ?? {},
        reason: e.reason,
      })),
      predicates,
    };
    const sys = `You configure a READ-ONLY records sync for a CRM-like HTTP API. You get a digest of its list operations (parameters, where the rows sit, the row's properties), a heuristic proposal, and the vocabulary of predicates the memory speaks. Answer the corrected configuration under the schema — one entry per entity worth remembering (deals/opportunities, leads, people/contacts, organizations/companies, tickets, tasks, products, orders; skip users, owners, stages, pipelines, settings, files, notes, activities and other lookups or plumbing).
Rules: entity \`type\` is a short lowercase noun in the memory's vocabulary (deal, lead, person, organization, ticket, task, product, order, invoice) or the API's own singular noun; \`list.path\` and every parameter name must come from the digest verbatim; \`paging.style\` is one of none/page/offset/cursor/link with \`param\` the page/offset/cursor parameter and \`next\` the dotted path in the answer to the next cursor or link, or null; \`incremental\` only when the digest has a query parameter that filters by modification time (name it verbatim; \`format\` iso/epoch/epoch_ms/date as the parameter's type suggests), else null; \`fields.id\`, \`fields.name\` (one or more properties joined with a space), \`fields.updatedAt\` are dotted paths into ONE ROW and must exist in rowProperties; \`relations\` only for row properties that carry ANOTHER record's id (a \`person_id\`, an \`organization\` object) with targetType one of the entity types you propose or deal/lead/person/organization; \`deleted\` is a boolean-ish row property that marks a deleted row, or null; \`mapping\` pairs row properties (attribute keys — never the id/name/updatedAt/relation fields) with predicates ONLY from the given list, at most one property per predicate; \`confidence\` 0–1; \`reason\` one line. Keep what the heuristic got right; fix what it got wrong; add what it missed. Output strictly the JSON shape requested.`;
    const res = await withGenAiCall(
      {
        kind: 'chat',
        spanName: 'gen_ai.chat.mapping_assistant',
        system: 'openai',
        model: this.model,
      },
      this.metrics,
      () =>
        openai.chat.completions.create({
          model: this.model,
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: JSON.stringify(input) },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'records_mapping_proposal', strict: true, schema: MODEL_SCHEMA },
          },
          ...chatCallParams(this.model, {
            temperature: 0,
            visibleCap: 6000,
            reasoningCap: 12_000,
            reasoningEffort: 'low',
          }),
        }),
    );
    const content = res.choices[0]?.message?.content;
    if (!content) throw new Error('empty answer');
    const parsed = JSON.parse(content) as { entities: ModelEntity[] };
    let accepted = 0;
    for (const m of parsed.entities ?? []) {
      const entry = toRestEntity(m);
      if (!entry) continue;
      const previous = p.proposals.get(m.type);
      const attributeKeys = previous?.attributeKeys ?? attributeKeysOfModel(m);
      p.proposals.set(m.type, {
        type: m.type,
        label: entry.label ?? m.type,
        endpoint: entry,
        source: previous?.source ?? 'openapi',
        confidence: Math.max(0, Math.min(1, m.confidence)),
        reason: m.reason.slice(0, 400),
        attributeKeys,
      });
      const fields: Record<string, string> = {};
      const taken = new Set<string>();
      for (const pair of m.mapping) {
        if (!predicates.includes(pair.predicate) || taken.has(pair.predicate)) continue;
        if (!attributeKeys.includes(pair.field)) continue;
        fields[pair.field] = pair.predicate;
        taken.add(pair.predicate);
      }
      p.mappings.set(m.type, { fields, coreType: coreTypeOf(m.type) });
      accepted++;
    }
    return accepted > 0;
  }
}

/** The heuristic proposals: one per entity from the document, each sample refining or adding one. */
function proposalsOf(
  digest: ApiDigest | null,
  samples: NonNullable<MappingAssistRequest['samples']>,
  warnings: string[],
): Map<string, EntityProposal> {
  const proposals = new Map<string, EntityProposal>();
  for (const p of digest ? proposeFromOperations(digest) : []) proposals.set(p.type, p);
  for (const sample of samples) {
    const p = proposeFromSample(sample);
    if (!p) {
      warnings.push(`a sample${sample.path ? ` for ${sample.path}` : ''} holds no rows`);
      continue;
    }
    // A sample refines the document's proposal for the same entity (it saw the real rows).
    const fromDoc = proposals.get(p.type);
    proposals.set(p.type, fromDoc ? mergeSampleOver(fromDoc, p) : p);
  }
  if (proposals.size === 0) {
    warnings.push('nothing to propose — no list operation or sample named a record collection');
  }
  return proposals;
}

/** The answer's endpoints / mapping / rows: the operator's own edits first, then the proposals. */
function assemble(
  req: MappingAssistRequest,
  proposals: Map<string, EntityProposal>,
  mappings: Map<string, EntityMapping>,
): Pick<MappingAssistResponse, 'endpoints' | 'mapping' | 'entities'> {
  const endpoints: Record<string, RestEntity> = {};
  const mapping: RecordMapping = {};
  const entities: MappingAssistResponse['entities'] = [];
  for (const [type, own] of Object.entries(req.endpoints ?? {})) {
    endpoints[type] = own;
    mapping[type] = mappings.get(type) ?? { fields: {}, coreType: coreTypeOf(type) };
    entities.push({
      type,
      label: own.label ?? type,
      source: 'operator',
      confidence: 1,
      reason: 'as you set it',
      fields: fieldsOf(proposals.get(type)?.attributeKeys ?? Object.keys(own.attributes ?? {})),
    });
  }
  for (const p of proposals.values()) {
    if (endpoints[p.type]) continue;
    endpoints[p.type] = p.endpoint;
    mapping[p.type] = mappings.get(p.type) ?? { fields: {}, coreType: coreTypeOf(p.type) };
    entities.push({
      type: p.type,
      label: p.label,
      source: p.source,
      confidence: p.confidence,
      reason: p.reason,
      fields: fieldsOf(p.attributeKeys),
    });
  }
  return { endpoints, mapping, entities };
}

/** A sample's reading of the rows (id / name / updated-at / relations / deleted) over the document's endpoint shape. */
function mergeSampleOver(doc: EntityProposal, sample: EntityProposal): EntityProposal {
  const paging = pagingOver(doc.endpoint.paging, sample.endpoint.paging);
  return {
    ...doc,
    endpoint: {
      ...doc.endpoint,
      ...(sample.endpoint.items ? { items: sample.endpoint.items } : {}),
      fields: sample.endpoint.fields,
      ...(sample.endpoint.relations ? { relations: sample.endpoint.relations } : {}),
      ...(sample.endpoint.deleted ? { deleted: sample.endpoint.deleted } : {}),
      ...(paging ? { paging } : {}),
    },
    confidence: Math.min(0.95, doc.confidence + 0.1),
    reason: `${doc.reason}; the sample confirmed the rows (${sample.reason.split(';')[0]})`,
    attributeKeys: sample.attributeKeys,
  };
}

/**
 * The sample saw the answer's VALUES, the document only its keys: a
 * "cursor" the sample found to be a URL is a link; the document keeps
 * the parameter names it read.
 */
function pagingOver(
  doc: RestEntity['paging'],
  sample: RestEntity['paging'],
): RestEntity['paging'] | undefined {
  if (!sample) return doc;
  if (!doc) return sample;
  if (doc.style !== 'cursor' && doc.style !== 'link') return doc;
  if (sample.style === 'link')
    return { style: 'link', ...(sample.next ? { next: sample.next } : {}) };
  return { ...doc, ...(sample.next ? { next: sample.next } : {}) };
}

function fieldsOf(keys: string[]): Array<{ key: string; label: string }> {
  return keys.map((key) => ({ key, label: key }));
}

/** The model's entry as a validated RestEntity, or null when the schema refuses it. */
function toRestEntity(m: ModelEntity): RestEntity | null {
  const candidate = {
    ...(m.label ? { label: m.label } : {}),
    list: { path: m.list.path, ...(m.list.method === 'POST' ? { method: 'POST' } : {}) },
    ...(m.items ? { items: m.items } : {}),
    ...(m.get ? { get: { path: m.get } } : {}),
    ...(m.paging && m.paging.style !== 'none'
      ? {
          paging: {
            style: m.paging.style,
            ...(m.paging.param ? { param: m.paging.param } : {}),
            ...(m.paging.sizeParam ? { sizeParam: m.paging.sizeParam } : {}),
            ...(m.paging.size ? { size: m.paging.size } : {}),
            ...(m.paging.next ? { next: m.paging.next } : {}),
          },
        }
      : {}),
    ...(m.incremental
      ? {
          incremental: {
            param: m.incremental.param,
            ...(m.incremental.format ? { format: m.incremental.format } : {}),
            ...(m.incremental.in ? { in: m.incremental.in } : {}),
          },
        }
      : {}),
    fields: {
      id: m.fields.id,
      name: m.fields.name,
      ...(m.fields.updatedAt ? { updatedAt: m.fields.updatedAt } : {}),
    },
    ...(m.relations.length
      ? {
          relations: m.relations.map((r) => ({
            kind: r.kind,
            targetType: r.targetType,
            path: r.path,
            ...(r.name ? { name: r.name } : {}),
          })),
        }
      : {}),
    ...(m.deleted ? { deleted: m.deleted } : {}),
  };
  const parsed = RestEntitySchema.safeParse(candidate);
  return parsed.success && /^[a-z][a-z0-9_]{0,31}$/.test(m.type) ? parsed.data : null;
}

function attributeKeysOfModel(m: ModelEntity): string[] {
  return m.mapping.map((x) => x.field);
}

const NULLABLE_STRING = { type: ['string', 'null'] };

/** The strict answer schema (every key required, optionals nullable — what strict mode demands). */
const MODEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string' },
          label: NULLABLE_STRING,
          list: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string' },
              method: { type: ['string', 'null'], enum: ['GET', 'POST', null] },
            },
            required: ['path', 'method'],
          },
          items: NULLABLE_STRING,
          get: NULLABLE_STRING,
          paging: {
            type: ['object', 'null'],
            additionalProperties: false,
            properties: {
              style: { type: 'string', enum: ['none', 'page', 'offset', 'cursor', 'link'] },
              param: NULLABLE_STRING,
              sizeParam: NULLABLE_STRING,
              size: { type: ['integer', 'null'] },
              next: NULLABLE_STRING,
            },
            required: ['style', 'param', 'sizeParam', 'size', 'next'],
          },
          incremental: {
            type: ['object', 'null'],
            additionalProperties: false,
            properties: {
              param: { type: 'string' },
              format: {
                type: ['string', 'null'],
                enum: ['iso', 'epoch', 'epoch_ms', 'date', null],
              },
              in: { type: ['string', 'null'], enum: ['query', 'body', null] },
            },
            required: ['param', 'format', 'in'],
          },
          fields: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              name: { type: 'array', items: { type: 'string' } },
              updatedAt: NULLABLE_STRING,
            },
            required: ['id', 'name', 'updatedAt'],
          },
          relations: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string' },
                targetType: { type: 'string' },
                path: { type: 'string' },
                name: NULLABLE_STRING,
              },
              required: ['kind', 'targetType', 'path', 'name'],
            },
          },
          deleted: NULLABLE_STRING,
          mapping: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { field: { type: 'string' }, predicate: { type: 'string' } },
              required: ['field', 'predicate'],
            },
          },
          confidence: { type: 'number' },
          reason: { type: 'string' },
        },
        required: [
          'type',
          'label',
          'list',
          'items',
          'get',
          'paging',
          'incremental',
          'fields',
          'relations',
          'deleted',
          'mapping',
          'confidence',
          'reason',
        ],
      },
    },
  },
  required: ['entities'],
} as const;
