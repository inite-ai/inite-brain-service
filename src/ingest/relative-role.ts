/**
 * A relative named by role — "Father", "my mom", "Both parents", "мама",
 * "minha irmã" — is a person of the speaker's own life, not a name.
 *
 * Entity identity is tenant-wide (#650): a mention resolves by its name
 * to the one node every conversation shares. For a proper name that is
 * the point. For a kinship role it is wrong: measured on HaluMem, two
 * users' "Father" and "Mother" became ONE entity each, carrying both
 * users' parents' birth dates (1963 and 1968) and supersession history.
 * The facts were fenced by userId, the identity was not — and the
 * identity is what profiles, edges, communities and the next mention's
 * resolution read.
 *
 * So under a userId such a mention anchors like the user's own entity
 * does: a PERSONAL entity (userId + `user:<id>` scope tag) filed under a
 * scoped reference, `relative:<role>`. The role is canonical across
 * surfaces and languages — "Father", "my dad" and "папа" are one node for
 * one user, and never the node of another user.
 *
 * Deliberately narrow:
 *  - kinship and family only. "Partner", "friend", "boss" or "the team"
 *    name business and social roles that ARE shared in a work tenant;
 *  - bare or first-person only ("my", "our", "мой" …). "His father",
 *    "Rui's mother" is someone else's relative — keying it under the
 *    user's own "father" would merge two people, so it falls through to
 *    the ordinary ladder;
 *  - without a userId nothing changes: there is no one to scope it to.
 *
 * Pure module — no NestJS, no DB.
 */
import type { ParticipantHint } from './participants';

/** The vertical relatives are filed under (scoped by the user, like `user`). */
export const RELATIVE_VERTICAL = 'relative';

/** Surface → canonical role. Keys are lowercased; plural and synonyms fold. */
const KIN: Readonly<Record<string, string>> = {
  // en
  father: 'father',
  dad: 'father',
  daddy: 'father',
  papa: 'father',
  mother: 'mother',
  mom: 'mother',
  mum: 'mother',
  mommy: 'mother',
  mummy: 'mother',
  mama: 'mother',
  parents: 'parents',
  brother: 'brother',
  brothers: 'brothers',
  sister: 'sister',
  sisters: 'sisters',
  sibling: 'sibling',
  siblings: 'siblings',
  son: 'son',
  sons: 'sons',
  daughter: 'daughter',
  daughters: 'daughters',
  child: 'child',
  children: 'children',
  kid: 'child',
  kids: 'children',
  wife: 'wife',
  husband: 'husband',
  spouse: 'spouse',
  boyfriend: 'boyfriend',
  girlfriend: 'girlfriend',
  fiance: 'fiance',
  fiancee: 'fiancee',
  grandmother: 'grandmother',
  grandma: 'grandmother',
  granny: 'grandmother',
  grandfather: 'grandfather',
  grandpa: 'grandfather',
  grandparents: 'grandparents',
  grandson: 'grandson',
  granddaughter: 'granddaughter',
  grandchildren: 'grandchildren',
  aunt: 'aunt',
  uncle: 'uncle',
  cousin: 'cousin',
  nephew: 'nephew',
  niece: 'niece',
  stepmother: 'stepmother',
  stepfather: 'stepfather',
  stepson: 'stepson',
  stepdaughter: 'stepdaughter',
  'mother-in-law': 'mother-in-law',
  'father-in-law': 'father-in-law',
  'in-laws': 'in-laws',
  family: 'family',
  // ru
  отец: 'father',
  папа: 'father',
  мать: 'mother',
  мама: 'mother',
  родители: 'parents',
  брат: 'brother',
  братья: 'brothers',
  сестра: 'sister',
  сёстры: 'sisters',
  сестры: 'sisters',
  сын: 'son',
  дочь: 'daughter',
  дочка: 'daughter',
  ребёнок: 'child',
  ребенок: 'child',
  дети: 'children',
  жена: 'wife',
  муж: 'husband',
  супруг: 'spouse',
  супруга: 'spouse',
  бабушка: 'grandmother',
  дедушка: 'grandfather',
  внук: 'grandson',
  внучка: 'granddaughter',
  тётя: 'aunt',
  тетя: 'aunt',
  дядя: 'uncle',
  племянник: 'nephew',
  племянница: 'niece',
  семья: 'family',
  // pt / es
  pai: 'father',
  padre: 'father',
  mãe: 'mother',
  madre: 'mother',
  pais: 'parents',
  padres: 'parents',
  irmão: 'brother',
  hermano: 'brother',
  irmã: 'sister',
  hermana: 'sister',
  filho: 'son',
  hijo: 'son',
  filha: 'daughter',
  hija: 'daughter',
  filhos: 'children',
  hijos: 'children',
  esposa: 'wife',
  esposo: 'husband',
  marido: 'husband',
  avó: 'grandmother',
  abuela: 'grandmother',
  avô: 'grandfather',
  abuelo: 'grandfather',
  tia: 'aunt',
  tía: 'aunt',
  tio: 'uncle',
  tío: 'uncle',
  família: 'family',
  familia: 'family',
  // de / fr
  vater: 'father',
  mutter: 'mother',
  eltern: 'parents',
  bruder: 'brother',
  schwester: 'sister',
  sohn: 'son',
  tochter: 'daughter',
  kinder: 'children',
  ehefrau: 'wife',
  ehemann: 'husband',
  oma: 'grandmother',
  opa: 'grandfather',
  tante: 'aunt',
  onkel: 'uncle',
  familie: 'family',
  père: 'father',
  mère: 'mother',
  frère: 'brother',
  sœur: 'sister',
  soeur: 'sister',
  fils: 'son',
  enfants: 'children',
  mari: 'husband',
  famille: 'family',
};

/** First-person possessives and "both" — what may precede a role and still be the speaker's own. */
const OWN = new Set([
  'my',
  'our',
  'both',
  'мой',
  'моя',
  'моё',
  'мое',
  'мои',
  'наш',
  'наша',
  'наше',
  'наши',
  'оба',
  'обе',
  'meu',
  'minha',
  'meus',
  'minhas',
  'nosso',
  'nossa',
  'nossos',
  'nossas',
  'mi',
  'mis',
  'nuestro',
  'nuestra',
  'nuestros',
  'nuestras',
  'mein',
  'meine',
  'unser',
  'unsere',
  'mon',
  'ma',
  'mes',
  'notre',
  'nos',
]);

/** Birth-order and step qualifiers that keep two relatives apart ("older brother" ≠ "younger brother"). */
const QUALIFIERS: Readonly<Record<string, string>> = {
  older: 'older',
  elder: 'older',
  big: 'older',
  oldest: 'oldest',
  eldest: 'oldest',
  younger: 'younger',
  little: 'younger',
  youngest: 'youngest',
  twin: 'twin',
  старший: 'older',
  старшая: 'older',
  младший: 'younger',
  младшая: 'younger',
};

/**
 * The canonical role a mention names, or undefined when it is not a bare
 * or first-person kinship role: "Father" → father, "my mom" → mother,
 * "Both parents" → parents, "моя младшая сестра" → younger sister.
 */
export function relativeRoleOf(name: string): string | undefined {
  const words = name
    .toLowerCase()
    .normalize('NFC')
    .replace(/[.,!?;:"'()«»“”]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  while (words.length > 0 && OWN.has(words[0]!)) words.shift();
  const head = words.pop();
  const role = head ? KIN[head] : undefined;
  if (!role) return undefined;
  const qualifiers: string[] = [];
  for (const w of words) {
    const q = QUALIFIERS[w];
    if (!q) return undefined; // anything else ("his", "Rui's", "new") is not the speaker's own role
    qualifiers.push(q);
  }
  return [...qualifiers, role].join(' ');
}

/**
 * The anchor for a relative named by role under a user's scope, or
 * undefined. The hint rung files it under `relative:<role>` scoped by
 * the user and mints it personal (entity-upsert hint path); the mention's
 * own form becomes its name.
 */
export function relativeHint(
  e: { name: string; canonical?: string | undefined },
  userId: string | undefined,
): ParticipantHint | undefined {
  if (!userId) return undefined;
  const role = relativeRoleOf(e.canonical ?? e.name) ?? relativeRoleOf(e.name);
  if (!role) return undefined;
  return {
    vertical: RELATIVE_VERTICAL,
    id: role,
    userId,
    name: withoutPossessive(e.canonical ?? e.name),
  };
}

/** "my mom" → "mom", "Both parents" → "parents": the name the relative goes by. */
function withoutPossessive(name: string): string {
  const words = name.trim().split(/\s+/);
  while (words.length > 1 && OWN.has(words[0]!.toLowerCase())) words.shift();
  return words.join(' ');
}
