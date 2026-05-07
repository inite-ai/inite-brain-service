import { Scenario } from '../types';

const ISO = (d: string) => new Date(d).toISOString();

/**
 * Graph-traversal scenarios — multi-entity link patterns that the
 * connections endpoint and search-by-association should resolve.
 *
 * The eval harness queries via /v1/search; for graph-shape assertions
 * we use queries that should only match one entity if the graph
 * structure surfaces correctly via fact-association.
 */
export const graphTraversalScenarios: Scenario[] = [
  {
    id: 'graph.team-with-shared-project',
    vertical: 'cross',
    description:
      'Two staff members and one project. Both staff linked via mentioned_with → project. Searching for the project should surface both staff via their facts.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'cross', id: 'staff_alice' },
        predicate: 'name',
        object: 'Alice Tanaka',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'cross' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'cross', id: 'staff_bob' },
        predicate: 'name',
        object: 'Bob Müller',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'cross' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'cross', id: 'project_phoenix' },
        predicate: 'name',
        object: 'Project Phoenix',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'cross' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'cross', id: 'staff_alice' },
        predicate: 'interacted_with',
        object: 'Project Phoenix kickoff meeting',
        validFrom: ISO('2026-04-15'),
        source: { vertical: 'cross', eventId: 'auth.meeting_attended' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'cross', id: 'staff_bob' },
        predicate: 'interacted_with',
        object: 'Project Phoenix architecture review',
        validFrom: ISO('2026-04-20'),
        source: { vertical: 'cross', eventId: 'auth.meeting_attended' },
      },
      {
        kind: 'link',
        from: { vertical: 'cross', id: 'staff_alice' },
        to: { vertical: 'cross', id: 'project_phoenix' },
        linkKind: 'mentioned_with',
        source: { vertical: 'cross' },
      },
      {
        kind: 'link',
        from: { vertical: 'cross', id: 'staff_bob' },
        to: { vertical: 'cross', id: 'project_phoenix' },
        linkKind: 'mentioned_with',
        source: { vertical: 'cross' },
      },
    ],
    queries: [
      {
        query: 'Project Phoenix kickoff',
        expectedTopEntityRef: 'cross.staff_alice',
        expectedFactPredicate: 'interacted_with',
      },
      {
        query: 'Project Phoenix architecture review',
        expectedTopEntityRef: 'cross.staff_bob',
        expectedFactPredicate: 'interacted_with',
      },
    ],
  },
  {
    id: 'graph.customer-with-multiple-complaints',
    vertical: 'rent',
    description:
      'Single tenant complains about three separate issues. Each complaint surfaces individually through semantic search.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'multicomplaint_cust' },
        predicate: 'name',
        object: 'Klaus Weber',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'rent' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'multicomplaint_cust' },
        predicate: 'complained_about',
        object: 'broken washing machine in unit 4B',
        validFrom: ISO('2026-04-10'),
        source: { vertical: 'rent', messageId: 'm_kw_1' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'multicomplaint_cust' },
        predicate: 'complained_about',
        object: 'noise from upstairs neighbours after midnight',
        validFrom: ISO('2026-04-15'),
        source: { vertical: 'rent', messageId: 'm_kw_2' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'multicomplaint_cust' },
        predicate: 'complained_about',
        object: 'parking space repeatedly taken by visitors',
        validFrom: ISO('2026-04-20'),
        source: { vertical: 'rent', messageId: 'm_kw_3' },
      },
    ],
    queries: [
      {
        query: 'who has appliance issues',
        expectedTopEntityRef: 'rent.multicomplaint_cust',
        expectedFactPredicate: 'complained_about',
      },
      {
        query: 'noise complaints from neighbours',
        expectedTopEntityRef: 'rent.multicomplaint_cust',
        expectedFactPredicate: 'complained_about',
      },
      {
        query: 'parking issues',
        expectedTopEntityRef: 'rent.multicomplaint_cust',
        expectedFactPredicate: 'complained_about',
      },
    ],
  },
];
