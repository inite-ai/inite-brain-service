import { Injectable } from '@nestjs/common';
import { PredicateRegistryService } from '../ai/predicate-registry.service';
import { SourcesService } from '../sources/sources.service';
import { ACTIONS, ActionFamily } from './action-registry';
import { POLICY_ATTRIBUTES, PolicyMacro, POLICY_MACROS } from './policy.types';

export interface PolicyRegistryPayload {
  actions: Array<{
    name: string;
    family: ActionFamily;
    kind: 'read' | 'write' | 'admin';
    title?: string;
  }>;
  macros: Array<{ id: PolicyMacro; actions: string[] }>;
  attributes: Array<{
    attr: string;
    type: 'string' | 'number' | 'boolean';
    ops: string[];
    description: string;
    /** Autocomplete hints (predicates / verticals / recorders). */
    values?: string[];
  }>;
  /** Dynamic attribute families the UI offers with a free key input. */
  dynamicAttributes: Array<{
    prefix: string;
    type: 'string';
    ops: string[];
    description: string;
  }>;
}

/**
 * The single source of truth for the policy editor's pickers: every
 * gateable action, macro expansions, and the attribute vocabulary with
 * per-tenant autocomplete hints (predicate ids, seen verticals and
 * recorders). The UI hardcodes nothing — a new tool or attribute shows
 * up here and every picker follows.
 */
@Injectable()
export class PolicyRegistryService {
  constructor(
    private readonly predicates: PredicateRegistryService,
    private readonly sources: SourcesService,
  ) {}

  async registry(companyId: string): Promise<PolicyRegistryPayload> {
    const actions = Object.entries(ACTIONS).map(([name, spec]) => ({
      name,
      family: spec.family,
      kind: spec.kind,
      ...(spec.title ? { title: spec.title } : {}),
    }));

    const macros = POLICY_MACROS.map((id) => ({
      id,
      actions: actions
        .filter((a) =>
          id === '@all' ? true : id === '@readonly' ? a.kind === 'read' : a.kind === 'write',
        )
        .map((a) => a.name),
    }));

    const [predicateIds, sourceHints] = await Promise.all([
      this.predicateIds(companyId),
      this.sourceHints(companyId),
    ]);

    const attributes = Object.entries(POLICY_ATTRIBUTES).map(([attr, spec]) => ({
      attr,
      type: spec.type,
      ops: spec.ops,
      description: spec.description,
      ...(attr === 'predicate' && predicateIds.length > 0
        ? { values: predicateIds }
        : {}),
      ...(attr === 'piiClass'
        ? { values: ['none', 'identifier', 'behavioral', 'text', 'sensitive'] }
        : {}),
      ...(attr === 'source.vertical' && sourceHints.verticals.length > 0
        ? { values: sourceHints.verticals }
        : {}),
      ...(attr === 'source.recorder' && sourceHints.recorders.length > 0
        ? { values: sourceHints.recorders }
        : {}),
    }));

    return {
      actions,
      macros,
      attributes,
      dynamicAttributes: [
        {
          prefix: 'source.meta.',
          type: 'string',
          ops: ['eq', 'in', 'exists', 'not_exists'],
          description:
            'Operator metadata projected from documents (IngestDocumentDto.meta) or direct facts (metadata)',
        },
      ],
    };
  }

  private async predicateIds(companyId: string): Promise<string[]> {
    try {
      const all = await this.predicates.listAll(companyId);
      return all
        .filter((p) => p.status === 'active')
        .map((p) => p.predicateId)
        .sort();
    } catch {
      return [];
    }
  }

  private async sourceHints(
    companyId: string,
  ): Promise<{ verticals: string[]; recorders: string[] }> {
    try {
      const summaries = await this.sources.list(companyId);
      const verticals = new Set<string>();
      const recorders = new Set<string>();
      for (const s of summaries) {
        // sourceKey format is `vertical:recorder` (fn::source_key_of).
        const idx = s.sourceKey.indexOf(':');
        if (idx > 0) {
          verticals.add(s.sourceKey.slice(0, idx));
          recorders.add(s.sourceKey.slice(idx + 1));
        }
      }
      return {
        verticals: [...verticals].sort(),
        recorders: [...recorders].sort(),
      };
    } catch {
      return { verticals: [], recorders: [] };
    }
  }
}
