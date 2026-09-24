import type {
  SourceAvailability,
  SourceCatalogEntry,
  SourceConnection,
} from '../../../lib/contracts/admin-source-connections';

/**
 * What an operator connects is a KIND of thing — a folder, a site, a
 * bucket, an MCP server, a repository — not a pack's `sources[]` entry.
 * A pack declares one entry per shape (text documents vs. files) of the
 * same thing; the catalogue shows one card per (pack, kind) and the
 * flow asks "what's in it" instead of listing the entries twice.
 */
export type SourceFamily =
  | 'folder'
  | 'bucket'
  | 'site'
  | 'mcp'
  | 'repo'
  | 'gdrive'
  | 'onedrive'
  | 'dropbox'
  | 'notion'
  | 'confluence'
  | 'gmail'
  | 'imap'
  | 'slack'
  | 'telegram'
  | 'records'
  | 'db'
  | 'external'
  | 'other';

/**
 * Where a kind sits on the page. Seventeen cards in one grid is a heap;
 * the catalogue and the connections table both fold by these groups,
 * in this order: the documents you already have, then what you read
 * over the network, then mail and chat, then records, then what is
 * pushed in.
 */
export type SourceGroup =
  'files' | 'web' | 'mail' | 'chat' | 'mcp' | 'code' | 'records' | 'external' | 'other';

export const SOURCE_GROUPS: readonly SourceGroup[] = [
  'files',
  'web',
  'mail',
  'chat',
  'mcp',
  'code',
  'records',
  'external',
  'other',
];

export function groupOf(family: SourceFamily): SourceGroup {
  switch (family) {
    case 'folder':
    case 'bucket':
    case 'gdrive':
    case 'onedrive':
    case 'dropbox':
      return 'files';
    case 'site':
    case 'notion':
    case 'confluence':
      return 'web';
    case 'gmail':
    case 'imap':
      return 'mail';
    case 'slack':
    case 'telegram':
      return 'chat';
    case 'mcp':
      return 'mcp';
    case 'repo':
      return 'code';
    case 'records':
    case 'db':
      return 'records';
    case 'external':
      return 'external';
    default:
      return 'other';
  }
}

export function familyOf(e: { kind: string; connector: string }): SourceFamily {
  if (e.kind === 'external') return 'external';
  if (e.kind === 'mcp') return 'mcp';
  switch (e.connector) {
    case 'fs':
      return 'folder';
    case 's3':
      return 'bucket';
    case 'url':
      return 'site';
    case 'git':
      return 'repo';
    case 'gdrive':
    case 'onedrive':
    case 'dropbox':
    case 'notion':
    case 'confluence':
    case 'gmail':
    case 'imap':
    case 'slack':
    case 'telegram':
      return e.connector;
    case 'pipedrive':
    case 'hubspot':
    case 'bitrix24':
    case 'kommo':
    case 'salesforce':
    case 'rest_records':
      return 'records';
    case 'db':
      return 'db';
    default:
      return 'other';
  }
}

export interface SourceCard {
  key: string;
  family: SourceFamily;
  packId: string;
  packVersion: string;
  builtin: boolean;
  accepted: boolean;
  /** The entries of this kind the pack declares, document shape first. */
  entries: SourceCatalogEntry[];
  /** The best availability across the entries (ready > agent > external > disabled > missing). */
  availability: SourceAvailability;
  connector: string;
  /** Set when another pack offers the same kind — the card then names its pack. */
  ambiguous: boolean;
}

/** The text-ish shape first (a mailbox's messages before its attachments), then files, then records. */
const SHAPE_ORDER: Record<string, number> = {
  document: 0,
  conversation: 1,
  binary: 2,
  structure: 3,
};
/** How kinds sit inside a group: what you own first, then the cloud drives, then the rest. */
const FAMILY_ORDER: Record<SourceFamily, number> = {
  folder: 0,
  bucket: 1,
  gdrive: 2,
  onedrive: 3,
  dropbox: 4,
  site: 5,
  notion: 6,
  confluence: 7,
  gmail: 8,
  imap: 9,
  slack: 10,
  telegram: 11,
  mcp: 12,
  repo: 13,
  records: 14,
  db: 15,
  external: 16,
  other: 17,
};
const AVAILABILITY_RANK: Record<SourceAvailability, number> = {
  ready: 0,
  agent: 1,
  external: 2,
  disabled: 3,
  missing: 4,
};

/** The kind of thing an entry reads, pack-independent: family + connector, and the transport for MCP. */
function kindKeyOf(e: SourceCatalogEntry): string {
  const family = familyOf(e);
  return `${family}/${family === 'mcp' ? (e.mcp?.transport ?? 'http') : e.connector}`;
}

/**
 * What a card says about itself. The generic kinds (a folder, a site, a
 * bucket) speak in the page's own words; a vendor connector or a push
 * door — where six cards would otherwise carry one sentence — shows the
 * pack's title and description, less the `config: {…}` tail meant for
 * the API reader.
 */
export function cardWords(
  card: SourceCard,
  familyWords: { title: string; body: string },
): { title: string; body: string } {
  const first = card.entries[0];
  const own = first?.description ? leadOf(first.description) : '';
  if (card.family === 'external') {
    return { title: first?.title ?? familyWords.title, body: own || familyWords.body };
  }
  if (card.family === 'records' || card.family === 'db') {
    return { title: familyWords.title, body: own || familyWords.body };
  }
  return { title: familyWords.title, body: familyWords.body || own };
}

function leadOf(description: string): string {
  const cut = description.search(/\s*config:\s*\{/);
  return (cut >= 0 ? description.slice(0, cut) : description).trim().replace(/[,;:]$/, '');
}

/** One card per (pack, kind), ready ones first, then agent, external, switched-off, missing. */
export function cardsOf(sources: SourceCatalogEntry[]): SourceCard[] {
  const byKey = new Map<string, SourceCard>();
  for (const e of sources) {
    const family = familyOf(e);
    const key = `${e.packId}/${kindKeyOf(e)}`;
    const card = byKey.get(key) ?? {
      key,
      family,
      packId: e.packId,
      packVersion: e.packVersion,
      builtin: e.builtin,
      accepted: e.accepted,
      entries: [],
      availability: e.availability,
      connector: e.connector,
      ambiguous: false,
    };
    card.entries.push(e);
    if (AVAILABILITY_RANK[e.availability] < AVAILABILITY_RANK[card.availability]) {
      card.availability = e.availability;
    }
    byKey.set(key, card);
  }
  const cards = [...byKey.values()];
  const kindsSeen = new Map<string, number>();
  for (const c of cards) {
    const k = kindKeyOf(c.entries[0]!);
    kindsSeen.set(k, (kindsSeen.get(k) ?? 0) + 1);
  }
  for (const c of cards) {
    c.entries.sort((a, b) => (SHAPE_ORDER[a.shape] ?? 9) - (SHAPE_ORDER[b.shape] ?? 9));
    c.ambiguous = (kindsSeen.get(kindKeyOf(c.entries[0]!)) ?? 0) > 1;
  }
  return cards.sort(
    (a, b) =>
      AVAILABILITY_RANK[a.availability] - AVAILABILITY_RANK[b.availability] ||
      FAMILY_ORDER[a.family] - FAMILY_ORDER[b.family] ||
      a.packId.localeCompare(b.packId),
  );
}

/** The choice the flow offers when a kind comes in more than one shape: its text (documents, or a mailbox's messages), its files, or both. */
export type ShapeChoice = 'document' | 'binary' | 'both';

/** A document or a conversation: what the "document" choice stands for. */
export function isTextShape(shape: string): boolean {
  return shape === 'document' || shape === 'conversation';
}

export function shapeChoices(card: SourceCard): ShapeChoice[] {
  const text = card.entries.some((e) => isTextShape(e.shape));
  const binary = card.entries.some((e) => e.shape === 'binary');
  return text && binary ? ['document', 'binary', 'both'] : [];
}

/** The entries a choice creates connections for (no choice = the card's first, text-shaped, entry). */
export function entriesFor(card: SourceCard, choice: ShapeChoice | null): SourceCatalogEntry[] {
  if (choice === 'both') {
    return card.entries.filter((e) => isTextShape(e.shape) || e.shape === 'binary');
  }
  if (choice === 'document') return card.entries.filter((e) => isTextShape(e.shape)).slice(0, 1);
  if (choice === 'binary') return card.entries.filter((e) => e.shape === 'binary').slice(0, 1);
  return card.entries.slice(0, 1);
}

/** The kind + shape line a connection reads as (`Folder · files`). */
export function connectionFamily(c: SourceConnection): SourceFamily {
  return familyOf(c);
}

export interface Grouped<T> {
  group: SourceGroup;
  items: T[];
}

/** The non-empty groups in page order, each keeping the order its items came in. */
function groupBy<T>(items: T[], groupOfItem: (item: T) => SourceGroup): Grouped<T>[] {
  const byGroup = new Map<SourceGroup, T[]>();
  for (const item of items) {
    const g = groupOfItem(item);
    const list = byGroup.get(g) ?? [];
    list.push(item);
    byGroup.set(g, list);
  }
  return SOURCE_GROUPS.flatMap((group) => {
    const list = byGroup.get(group);
    return list ? [{ group, items: list }] : [];
  });
}

/** The catalogue's cards by group; inside a group `cardsOf`'s order holds (ready first). */
export function groupCards(cards: SourceCard[]): Grouped<SourceCard>[] {
  return groupBy(cards, (c) => groupOf(c.family));
}

/** What a connection is called on the page: its label, else `pack/source`. */
export function labelOf(c: SourceConnection): string {
  return c.label ?? `${c.packId}/${c.sourceId}`;
}

/** A tenant's connections by group, alphabetical by label inside a group — the API's order is insertion order. */
export function groupConnections(connections: SourceConnection[]): Grouped<SourceConnection>[] {
  const sorted = [...connections].sort((a, b) => labelOf(a).localeCompare(labelOf(b)));
  return groupBy(sorted, (c) => groupOf(familyOf(c)));
}

/** The rows a filter keeps: label, pack, source id or connector contains the query, case-insensitively. */
export function matchesQuery(c: SourceConnection, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [labelOf(c), c.packId, c.sourceId, c.connector, c.host].some((v) =>
    v.toLowerCase().includes(q),
  );
}
