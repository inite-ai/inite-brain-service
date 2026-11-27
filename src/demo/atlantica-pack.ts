/**
 * The demo pack: Ana's workspace at «Atlântica Group (demo)», a small
 * Brazil/Portugal hospitality group opening a second office in Lisbon.
 *
 * Every person and company here is made up. No real address, no real
 * mailbox, no phone number, no external link: the only addresses are
 * `@demo.invalid`, and sources are referenced by an internal `demo:` ref.
 * The seed (demo-seed.ts) writes this pack into the demo tenant without a
 * model call: entities, facts and edges are written as they are here, so
 * the graph is the same on every run.
 *
 * Facts carry no PII predicate (email, phone, dob): the demo is read with
 * `brain:read` only, and a PII fact would only ever show as redacted.
 */

/** The engine's entity types (knowledge_entity.type ASSERT). */
export type DemoEntityType =
  'customer' | 'staff' | 'asset' | 'project' | 'topic' | 'location' | 'other';

export interface DemoEntity {
  /** Stable key; the record id is `knowledge_entity:demo_<key>`. */
  key: string;
  type: DemoEntityType;
  name: string;
  aliases?: string[];
}

export interface DemoSource {
  /** Stable key; facts point at it with `demo:<key>`. */
  key: string;
  kind: 'document' | 'message' | 'conversation' | 'other';
  title: string;
  /** When the source was written (ISO date). */
  date: string;
}

export interface DemoFact {
  key: string;
  entity: string;
  predicate: string;
  object: string;
  validFrom: string;
  validUntil?: string;
  confidence: number;
  source: string;
}

export interface DemoEdge {
  from: string;
  to: string;
  kind: string;
  validFrom: string;
  source: string;
}

export interface DemoPack {
  id: string;
  version: number;
  entities: DemoEntity[];
  sources: DemoSource[];
  facts: DemoFact[];
  edges: DemoEdge[];
}

const ENTITIES: DemoEntity[] = [
  { key: 'atlantica', type: 'other', name: 'Atlântica Group', aliases: ['Atlântica'] },
  { key: 'ana', type: 'staff', name: 'Ana Demo', aliases: ['Ana'] },
  { key: 'bruno', type: 'staff', name: 'Bruno Demo', aliases: ['Bruno'] },
  { key: 'carla', type: 'staff', name: 'Carla Demo', aliases: ['Carla'] },
  { key: 'mariana', type: 'staff', name: 'Mariana Costa', aliases: ['Mariana'] },
  { key: 'rui', type: 'other', name: 'Rui Almeida', aliases: ['Rui'] },
  { key: 'tejo', type: 'other', name: 'Tejo Imóveis' },
  { key: 'grao', type: 'other', name: 'Grão Verde Cafés', aliases: ['Grão Verde'] },
  { key: 'mare', type: 'customer', name: 'Hotel Maré Alta', aliases: ['Maré Alta'] },
  { key: 'sp_office', type: 'location', name: 'São Paulo office' },
  { key: 'lisbon_office', type: 'location', name: 'Lisbon office' },
  { key: 'lisbon_opening', type: 'project', name: 'Lisbon opening' },
  { key: 'mare_deal', type: 'topic', name: 'Maré Alta breakfast contract' },
];

const SOURCES: DemoSource[] = [
  {
    key: 'board_2026_09',
    kind: 'document',
    title: 'Board meeting notes, 14 September 2026',
    date: '2026-09-14',
  },
  {
    key: 'lease_email',
    kind: 'message',
    title: 'Email from Rui Almeida about the Lisbon lease',
    date: '2026-10-02',
  },
  { key: 'crm_export', kind: 'document', title: 'CRM export, October 2026', date: '2026-10-15' },
  {
    key: 'mare_call',
    kind: 'conversation',
    title: 'Call notes with Hotel Maré Alta',
    date: '2026-10-21',
  },
  {
    key: 'supplier_contract',
    kind: 'document',
    title: 'Supply contract with Grão Verde Cafés',
    date: '2026-08-30',
  },
  {
    key: 'ops_weekly',
    kind: 'document',
    title: 'Operations weekly, 3 November 2026',
    date: '2026-11-03',
  },
];

const FACTS: DemoFact[] = [
  // The group
  {
    key: 'atl_industry',
    entity: 'atlantica',
    predicate: 'industry',
    object: 'hospitality: cafés, breakfast catering for hotels',
    validFrom: '2019-03-01T00:00:00Z',
    confidence: 0.95,
    source: 'crm_export',
  },
  {
    key: 'atl_headcount',
    entity: 'atlantica',
    predicate: 'headcount',
    object: '48 people across São Paulo and Lisbon',
    validFrom: '2026-11-03T00:00:00Z',
    confidence: 0.85,
    source: 'ops_weekly',
  },
  // People
  {
    key: 'ana_title',
    entity: 'ana',
    predicate: 'job_title',
    object: 'founder and CEO',
    validFrom: '2019-03-01T00:00:00Z',
    confidence: 0.95,
    source: 'crm_export',
  },
  {
    key: 'ana_pref',
    entity: 'ana',
    predicate: 'preference',
    object: 'wants a one-page summary before every board meeting',
    validFrom: '2026-09-14T00:00:00Z',
    confidence: 0.8,
    source: 'board_2026_09',
  },
  {
    key: 'bruno_title',
    entity: 'bruno',
    predicate: 'job_title',
    object: 'operations director',
    validFrom: '2024-02-01T00:00:00Z',
    confidence: 0.95,
    source: 'crm_export',
  },
  {
    key: 'bruno_owns',
    entity: 'bruno',
    predicate: 'responsible_for',
    object: 'fitting out the Lisbon office and hiring the first Lisbon team',
    validFrom: '2026-09-14T00:00:00Z',
    confidence: 0.9,
    source: 'board_2026_09',
  },
  {
    key: 'carla_title',
    entity: 'carla',
    predicate: 'job_title',
    object: 'customer care lead',
    validFrom: '2025-05-12T00:00:00Z',
    confidence: 0.95,
    source: 'crm_export',
  },
  {
    key: 'carla_owns',
    entity: 'carla',
    predicate: 'responsible_for',
    object: 'the Hotel Maré Alta account day to day',
    validFrom: '2026-10-21T00:00:00Z',
    confidence: 0.85,
    source: 'mare_call',
  },
  {
    key: 'mariana_title',
    entity: 'mariana',
    predicate: 'job_title',
    object: 'head of finance',
    validFrom: '2023-01-09T00:00:00Z',
    confidence: 0.95,
    source: 'crm_export',
  },
  {
    key: 'mariana_budget',
    entity: 'mariana',
    predicate: 'decision',
    object: 'capped the Lisbon fit-out budget at EUR 180,000',
    validFrom: '2026-09-14T00:00:00Z',
    confidence: 0.9,
    source: 'board_2026_09',
  },
  {
    key: 'rui_title',
    entity: 'rui',
    predicate: 'job_title',
    object: 'leasing partner at Tejo Imóveis',
    validFrom: '2026-10-02T00:00:00Z',
    confidence: 0.85,
    source: 'lease_email',
  },
  // Lisbon
  {
    key: 'lisbon_address',
    entity: 'lisbon_office',
    predicate: 'address',
    object: 'Rua do Exemplo 12, Lisboa (demo address)',
    validFrom: '2026-10-02T00:00:00Z',
    confidence: 0.9,
    source: 'lease_email',
  },
  {
    key: 'lisbon_rent',
    entity: 'lisbon_office',
    predicate: 'monthly_rent',
    object: 'EUR 6,400 a month, first three months at half rent',
    validFrom: '2026-10-02T00:00:00Z',
    confidence: 0.9,
    source: 'lease_email',
  },
  {
    key: 'lisbon_lease_start',
    entity: 'lisbon_office',
    predicate: 'lease_start',
    object: '1 December 2026',
    validFrom: '2026-10-02T00:00:00Z',
    confidence: 0.9,
    source: 'lease_email',
  },
  // The opening date moved: the board said January, operations now say March.
  {
    key: 'opening_target_jan',
    entity: 'lisbon_opening',
    predicate: 'target_date',
    object: 'January 2027',
    validFrom: '2026-09-14T00:00:00Z',
    validUntil: '2026-11-03T00:00:00Z',
    confidence: 0.8,
    source: 'board_2026_09',
  },
  {
    key: 'opening_target_mar',
    entity: 'lisbon_opening',
    predicate: 'target_date',
    object: 'March 2027, after the kitchen permit',
    validFrom: '2026-11-03T00:00:00Z',
    confidence: 0.85,
    source: 'ops_weekly',
  },
  {
    key: 'opening_status',
    entity: 'lisbon_opening',
    predicate: 'status',
    object: 'waiting for the kitchen permit from the city',
    validFrom: '2026-11-03T00:00:00Z',
    confidence: 0.85,
    source: 'ops_weekly',
  },
  {
    key: 'opening_next',
    entity: 'lisbon_opening',
    predicate: 'next_step',
    object: 'Bruno to send the permit file to the architect by 15 November',
    validFrom: '2026-11-03T00:00:00Z',
    confidence: 0.8,
    source: 'ops_weekly',
  },
  // São Paulo
  {
    key: 'sp_address',
    entity: 'sp_office',
    predicate: 'address',
    object: 'Rua Exemplo 400, Pinheiros, São Paulo (demo address)',
    validFrom: '2019-03-01T00:00:00Z',
    confidence: 0.9,
    source: 'crm_export',
  },
  // Supplier
  {
    key: 'grao_supplies',
    entity: 'grao',
    predicate: 'supplies',
    object: 'coffee beans for every café, delivered every Monday',
    validFrom: '2026-09-01T00:00:00Z',
    confidence: 0.9,
    source: 'supplier_contract',
  },
  {
    key: 'grao_terms',
    entity: 'grao',
    predicate: 'payment_terms',
    object: '30 days after delivery',
    validFrom: '2026-09-01T00:00:00Z',
    confidence: 0.9,
    source: 'supplier_contract',
  },
  // Client and deal
  {
    key: 'mare_industry',
    entity: 'mare',
    predicate: 'industry',
    object: 'hotel, 120 rooms',
    validFrom: '2026-10-15T00:00:00Z',
    confidence: 0.85,
    source: 'crm_export',
  },
  {
    key: 'mare_complaint',
    entity: 'mare',
    predicate: 'complained_about',
    object: 'late breakfast deliveries on two Sundays in October',
    validFrom: '2026-10-21T00:00:00Z',
    confidence: 0.85,
    source: 'mare_call',
  },
  {
    key: 'mare_intent',
    entity: 'mare',
    predicate: 'intent',
    object: 'wants a vegan breakfast option before the summer season',
    validFrom: '2026-10-21T00:00:00Z',
    confidence: 0.8,
    source: 'mare_call',
  },
  {
    key: 'deal_stage',
    entity: 'mare_deal',
    predicate: 'deal_stage',
    object: 'proposal sent',
    validFrom: '2026-10-21T00:00:00Z',
    confidence: 0.9,
    source: 'mare_call',
  },
  {
    key: 'deal_amount',
    entity: 'mare_deal',
    predicate: 'deal_amount',
    object: 'BRL 38,000 a month',
    validFrom: '2026-10-21T00:00:00Z',
    confidence: 0.85,
    source: 'mare_call',
  },
];

const EDGES: DemoEdge[] = [
  {
    from: 'ana',
    to: 'atlantica',
    kind: 'works_at',
    validFrom: '2019-03-01T00:00:00Z',
    source: 'crm_export',
  },
  {
    from: 'bruno',
    to: 'atlantica',
    kind: 'works_at',
    validFrom: '2024-02-01T00:00:00Z',
    source: 'crm_export',
  },
  {
    from: 'carla',
    to: 'atlantica',
    kind: 'works_at',
    validFrom: '2025-05-12T00:00:00Z',
    source: 'crm_export',
  },
  {
    from: 'mariana',
    to: 'atlantica',
    kind: 'works_at',
    validFrom: '2023-01-09T00:00:00Z',
    source: 'crm_export',
  },
  {
    from: 'bruno',
    to: 'ana',
    kind: 'reports_to',
    validFrom: '2024-02-01T00:00:00Z',
    source: 'crm_export',
  },
  {
    from: 'carla',
    to: 'bruno',
    kind: 'reports_to',
    validFrom: '2025-05-12T00:00:00Z',
    source: 'crm_export',
  },
  {
    from: 'rui',
    to: 'tejo',
    kind: 'works_at',
    validFrom: '2026-10-02T00:00:00Z',
    source: 'lease_email',
  },
  {
    from: 'atlantica',
    to: 'sp_office',
    kind: 'located_in',
    validFrom: '2019-03-01T00:00:00Z',
    source: 'crm_export',
  },
  {
    from: 'atlantica',
    to: 'lisbon_office',
    kind: 'leases',
    validFrom: '2026-10-02T00:00:00Z',
    source: 'lease_email',
  },
  {
    from: 'tejo',
    to: 'lisbon_office',
    kind: 'owns',
    validFrom: '2026-10-02T00:00:00Z',
    source: 'lease_email',
  },
  {
    from: 'bruno',
    to: 'lisbon_opening',
    kind: 'leads',
    validFrom: '2026-09-14T00:00:00Z',
    source: 'board_2026_09',
  },
  {
    from: 'lisbon_opening',
    to: 'lisbon_office',
    kind: 'about',
    validFrom: '2026-09-14T00:00:00Z',
    source: 'board_2026_09',
  },
  {
    from: 'grao',
    to: 'atlantica',
    kind: 'supplies',
    validFrom: '2026-09-01T00:00:00Z',
    source: 'supplier_contract',
  },
  {
    from: 'mare',
    to: 'atlantica',
    kind: 'client_of',
    validFrom: '2026-10-15T00:00:00Z',
    source: 'crm_export',
  },
  {
    from: 'mare_deal',
    to: 'mare',
    kind: 'with',
    validFrom: '2026-10-21T00:00:00Z',
    source: 'mare_call',
  },
  {
    from: 'carla',
    to: 'mare',
    kind: 'account_manager_of',
    validFrom: '2026-10-21T00:00:00Z',
    source: 'mare_call',
  },
];

export const ATLANTICA_DEMO_PACK: DemoPack = {
  id: 'atlantica-demo',
  version: 1,
  entities: ENTITIES,
  sources: SOURCES,
  facts: FACTS,
  edges: EDGES,
};
