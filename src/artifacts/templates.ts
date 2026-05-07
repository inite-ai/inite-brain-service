/**
 * Artifact template registry — compilation templates per artifact type.
 *
 * Each template extracts a typed view from the raw fact array. New
 * artifact types ship as new template entries here; no schema migration
 * needed (the `artifactType` field on knowledge_artifact is free-form
 * after migration 0004.1).
 *
 * Per-vertical types ARE NOT vertical-private: the brain holds a
 * single fact table per tenant, and a template selects the predicates
 * relevant to its lens. A `tenant_dossier` template for inite.rent
 * pulls vehicle / lease facts; the same entity also has a
 * `customer_profile` view (cross-vertical generic). Callers ask for
 * the lens they need.
 *
 * Field name → predicate map for the PII gate lives in
 * ARTIFACT_FIELD_TO_PREDICATE below.
 */

export interface FactRow {
  id: unknown;
  predicate: string;
  object: string;
  confidence: number;
  validFrom: string;
  recordedAt: string;
  source: any;
  status: string;
}

export interface Citation {
  factId: string;
  confidence: number;
  recordedAt: string;
  source: any;
}

export interface CompiledArtifact {
  payload: Record<string, unknown>;
  citations: Record<string, Citation[]>;
  sourceFactIds: string[];
}

export type Template = (facts: FactRow[]) => CompiledArtifact;

const cite = (f: FactRow): Citation => ({
  factId: String(f.id),
  confidence: f.confidence,
  recordedAt: new Date(f.recordedAt).toISOString(),
  source: f.source,
});

const latestSingle = (facts: FactRow[], predicate: string) =>
  facts
    .filter((f) => f.predicate === predicate)
    .sort(
      (a, b) =>
        new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime(),
    )[0];

const allOf = (facts: FactRow[], predicate: string) =>
  facts
    .filter((f) => f.predicate === predicate)
    .sort(
      (a, b) =>
        new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime(),
    );

const empty = (): CompiledArtifact => ({
  payload: {},
  citations: {},
  sourceFactIds: [],
});

/**
 * Add a single-active field (latest fact's object → payload[fieldName]).
 * Mutates compiled in place; returns the source fact id (or undefined).
 */
const addSingle = (
  compiled: CompiledArtifact,
  facts: FactRow[],
  fieldName: string,
  predicate: string,
): string | undefined => {
  const f = latestSingle(facts, predicate);
  if (!f) return undefined;
  compiled.payload[fieldName] = f.object;
  compiled.citations[fieldName] = [cite(f)];
  compiled.sourceFactIds.push(String(f.id));
  return String(f.id);
};

/**
 * Add an append-only field — top-N facts as an array. Each fact gets
 * a citation entry parallel to the array entry.
 */
const addList = (
  compiled: CompiledArtifact,
  facts: FactRow[],
  fieldName: string,
  predicate: string,
  topN: number,
) => {
  const subset = allOf(facts, predicate).slice(0, topN);
  if (subset.length === 0) return;
  compiled.payload[fieldName] = subset.map((f) => f.object);
  compiled.citations[fieldName] = subset.map(cite);
  for (const f of subset) compiled.sourceFactIds.push(String(f.id));
};

// ─── Generic templates (work for any vertical) ───────────────────

const customerProfile: Template = (facts) => {
  const c = empty();
  addSingle(c, facts, 'name', 'name');
  addSingle(c, facts, 'tier', 'tier');
  addSingle(c, facts, 'status', 'status');
  addSingle(c, facts, 'email', 'email');
  addSingle(c, facts, 'phone', 'phone');
  addList(c, facts, 'recentInteractions', 'interacted_with', 5);
  return c;
};

const supportContext: Template = (facts) => {
  const c = empty();
  const complaints = allOf(facts, 'complained_about').slice(0, 10);
  if (complaints.length > 0) {
    c.payload.complaints = complaints.map((f) => f.object);
    c.citations.complaints = complaints.map(cite);
    for (const f of complaints) c.sourceFactIds.push(String(f.id));
  }
  const said = allOf(facts, 'said').slice(0, 10);
  if (said.length > 0) {
    c.payload.recentUtterances = said.map((f) => f.object);
    c.citations.recentUtterances = said.map(cite);
    for (const f of said) c.sourceFactIds.push(String(f.id));
  }
  c.payload.complaintCount = complaints.length;
  c.payload.utteranceCount = said.length;
  return c;
};

const riskSnapshot: Template = (facts) => {
  const c = empty();
  const competing = facts.filter((f) => f.status === 'competing');
  if (competing.length > 0) {
    c.payload.competingFacts = competing.map((f) => ({
      predicate: f.predicate,
      object: f.object,
      confidence: f.confidence,
    }));
    c.citations.competingFacts = competing.map(cite);
    for (const f of competing) c.sourceFactIds.push(String(f.id));
  }
  const lowConf = facts.filter((f) => f.confidence < 0.5);
  if (lowConf.length > 0) {
    c.payload.lowConfidenceFacts = lowConf.map((f) => ({
      predicate: f.predicate,
      object: f.object,
      confidence: f.confidence,
    }));
    c.citations.lowConfidenceFacts = lowConf.map(cite);
    for (const f of lowConf) c.sourceFactIds.push(String(f.id));
  }
  c.payload.totalActiveFacts = facts.length;
  c.payload.competingCount = competing.length;
  c.payload.lowConfidenceCount = lowConf.length;
  return c;
};

const identityDossier: Template = (facts) => {
  const c = empty();
  for (const pred of ['name', 'email', 'phone', 'address', 'dob']) {
    const matches = allOf(facts, pred);
    if (matches.length === 0) continue;
    c.payload[pred] = matches.map((f) => f.object);
    c.citations[pred] = matches.map(cite);
    for (const f of matches) c.sourceFactIds.push(String(f.id));
  }
  return c;
};

// ─── Per-vertical templates ──────────────────────────────────────
//
// Templates below pull vertical-specific predicates. Predicates not in
// the brain core vocabulary (knowledge.yaml) are domain extensions
// declared by the vertical's manifest under
// `knowledge.domain_predicates:`. Brain treats unknown predicates as
// `default` policy (bitemporal, decay 60d, pii=none) until the spec
// adds them. Templates here read those domain predicates by their
// *expected* names — if the vertical hasn't ingested any, the field
// is simply absent from the artifact.

/** inite.rent — tenant dossier for car-rental operators. */
const tenantDossier: Template = (facts) => {
  const c = empty();
  addSingle(c, facts, 'name', 'name');
  addSingle(c, facts, 'tier', 'tier');
  addSingle(c, facts, 'status', 'status');
  addList(c, facts, 'rentalHistory', 'rented_vehicle', 10);
  addList(c, facts, 'paymentEvents', 'paid_invoice', 10);
  addList(c, facts, 'incidents', 'reported_incident', 5);
  addList(c, facts, 'preferences', 'preference', 5);
  return c;
};

/** inite.estate — listing card for property listings. */
const listingCard: Template = (facts) => {
  const c = empty();
  addSingle(c, facts, 'title', 'name');
  addSingle(c, facts, 'price', 'listed_price');
  addSingle(c, facts, 'status', 'status');
  addSingle(c, facts, 'bedrooms', 'bedrooms');
  addSingle(c, facts, 'bathrooms', 'bathrooms');
  addSingle(c, facts, 'floorArea', 'floor_area');
  addList(c, facts, 'amenities', 'amenity', 20);
  addList(c, facts, 'recentViewings', 'viewed_by', 10);
  return c;
};

/** inite.estate — prospect summary for buyers/renters interested in listings. */
const prospectSummary: Template = (facts) => {
  const c = empty();
  addSingle(c, facts, 'name', 'name');
  addSingle(c, facts, 'budget', 'budget');
  addSingle(c, facts, 'desiredArea', 'desired_area');
  addList(c, facts, 'viewedListings', 'viewed_listing', 10);
  addList(c, facts, 'preferences', 'preference', 10);
  addList(c, facts, 'objections', 'complained_about', 5);
  return c;
};

/** inite.events — attendee history (concerts, classes, conferences). */
const attendeeHistory: Template = (facts) => {
  const c = empty();
  addSingle(c, facts, 'name', 'name');
  addSingle(c, facts, 'tier', 'tier');
  addList(c, facts, 'attendedEvents', 'attended_event', 20);
  addList(c, facts, 'purchasedTickets', 'purchased_ticket', 10);
  addList(c, facts, 'preferences', 'preference', 5);
  return c;
};

/** inite.health — patient summary (heavy PII; per-field gating active). */
const patientSummary: Template = (facts) => {
  const c = empty();
  addSingle(c, facts, 'name', 'name');
  addSingle(c, facts, 'dob', 'dob');
  addSingle(c, facts, 'status', 'status');
  addList(c, facts, 'medications', 'prescribed_medication', 20);
  addList(c, facts, 'allergies', 'has_allergy', 10);
  addList(c, facts, 'recentAppointments', 'attended_appointment', 10);
  addList(c, facts, 'recentTreatments', 'received_treatment', 10);
  addList(c, facts, 'concerns', 'complained_about', 5);
  return c;
};

/** inite.shop — order history with LTV. */
const orderHistory: Template = (facts) => {
  const c = empty();
  addSingle(c, facts, 'name', 'name');
  addSingle(c, facts, 'tier', 'tier');
  addSingle(c, facts, 'status', 'status');
  addList(c, facts, 'recentOrders', 'placed_order', 20);
  addList(c, facts, 'returns', 'returned_item', 10);
  addList(c, facts, 'reviews', 'reviewed_product', 10);
  return c;
};

/** inite.club — community member profile. */
const memberProfile: Template = (facts) => {
  const c = empty();
  addSingle(c, facts, 'name', 'name');
  addSingle(c, facts, 'tier', 'tier');
  addSingle(c, facts, 'joinDate', 'joined_at');
  addList(c, facts, 'attendedMeetups', 'attended_meetup', 10);
  addList(c, facts, 'contributions', 'contributed_to', 10);
  addList(c, facts, 'interests', 'interested_in', 10);
  return c;
};

/** inite.education — learner progress (courses, grades, AI tutor notes). */
const learnerProgress: Template = (facts) => {
  const c = empty();
  addSingle(c, facts, 'name', 'name');
  addSingle(c, facts, 'currentLevel', 'level');
  addList(c, facts, 'enrolledCourses', 'enrolled_in', 10);
  addList(c, facts, 'completedCourses', 'completed_course', 20);
  addList(c, facts, 'recentScores', 'scored', 10);
  addList(c, facts, 'tutorNotes', 'said', 10);
  addList(c, facts, 'strugglingTopics', 'complained_about', 5);
  return c;
};

/** inite.sport — athlete card (training, performance, team). */
const athleteCard: Template = (facts) => {
  const c = empty();
  addSingle(c, facts, 'name', 'name');
  addSingle(c, facts, 'team', 'plays_for');
  addSingle(c, facts, 'position', 'plays_position');
  addList(c, facts, 'recentMatches', 'played_match', 10);
  addList(c, facts, 'trainingSessions', 'attended_training', 10);
  addList(c, facts, 'achievements', 'achieved', 10);
  return c;
};

/** inite.travel — traveler history (trips, preferences). */
const travelerHistory: Template = (facts) => {
  const c = empty();
  addSingle(c, facts, 'name', 'name');
  addSingle(c, facts, 'tier', 'tier');
  addList(c, facts, 'recentTrips', 'completed_trip', 10);
  addList(c, facts, 'bookings', 'booked_trip', 10);
  addList(c, facts, 'destinations', 'visited_destination', 20);
  addList(c, facts, 'preferences', 'preference', 10);
  return c;
};

/** inite.food — diner preferences (cuisine, dietary, ordering history). */
const dinerPreferences: Template = (facts) => {
  const c = empty();
  addSingle(c, facts, 'name', 'name');
  addList(c, facts, 'dietaryRestrictions', 'dietary_restriction', 10);
  addList(c, facts, 'favouriteCuisines', 'preference', 10);
  addList(c, facts, 'recentOrders', 'placed_order', 10);
  addList(c, facts, 'visitedRestaurants', 'visited_restaurant', 10);
  return c;
};

/** inite.studio — booking history for studio rentals. */
const studioBookings: Template = (facts) => {
  const c = empty();
  addSingle(c, facts, 'name', 'name');
  addList(c, facts, 'recentBookings', 'booked_session', 10);
  addList(c, facts, 'instruments', 'requested_instrument', 5);
  addList(c, facts, 'genres', 'preference', 5);
  return c;
};

/** inite.ai — usage and feedback for an AI agent end-user. */
const aiUserContext: Template = (facts) => {
  const c = empty();
  addSingle(c, facts, 'name', 'name');
  addSingle(c, facts, 'plan', 'tier');
  addList(c, facts, 'recentPrompts', 'said', 20);
  addList(c, facts, 'feedback', 'rated', 10);
  addList(c, facts, 'preferences', 'preference', 10);
  return c;
};

// ─── Registry ────────────────────────────────────────────────────

export const TEMPLATES: Record<string, Template> = {
  // generic
  customer_profile: customerProfile,
  support_context: supportContext,
  risk_snapshot: riskSnapshot,
  identity_dossier: identityDossier,
  // per-vertical
  tenant_dossier: tenantDossier,
  listing_card: listingCard,
  prospect_summary: prospectSummary,
  attendee_history: attendeeHistory,
  patient_summary: patientSummary,
  order_history: orderHistory,
  member_profile: memberProfile,
  learner_progress: learnerProgress,
  athlete_card: athleteCard,
  traveler_history: travelerHistory,
  diner_preferences: dinerPreferences,
  studio_bookings: studioBookings,
  ai_user_context: aiUserContext,
};

/**
 * Map artifact field name → underlying predicate. Used by the PII gate
 * in ArtifactsService.shapeForReturn to know whether a field's source
 * predicate requires a scope. Fields not in this map are assumed to
 * use their literal name as the predicate (safe default).
 */
export const ARTIFACT_FIELD_TO_PREDICATE: Record<string, string> = {
  // generic composite fields
  recentInteractions: 'interacted_with',
  complaints: 'complained_about',
  recentUtterances: 'said',
  competingFacts: 'status',
  lowConfidenceFacts: 'status',
  // rent
  rentalHistory: 'rented_vehicle',
  paymentEvents: 'paid_invoice',
  incidents: 'reported_incident',
  preferences: 'preference',
  // estate
  amenities: 'amenity',
  recentViewings: 'viewed_by',
  viewedListings: 'viewed_listing',
  objections: 'complained_about',
  // events
  attendedEvents: 'attended_event',
  purchasedTickets: 'purchased_ticket',
  // health
  medications: 'prescribed_medication',
  allergies: 'has_allergy',
  recentAppointments: 'attended_appointment',
  recentTreatments: 'received_treatment',
  concerns: 'complained_about',
  // shop
  recentOrders: 'placed_order',
  returns: 'returned_item',
  reviews: 'reviewed_product',
  // club
  attendedMeetups: 'attended_meetup',
  contributions: 'contributed_to',
  interests: 'interested_in',
  // education
  enrolledCourses: 'enrolled_in',
  completedCourses: 'completed_course',
  recentScores: 'scored',
  tutorNotes: 'said',
  strugglingTopics: 'complained_about',
  // sport
  recentMatches: 'played_match',
  trainingSessions: 'attended_training',
  achievements: 'achieved',
  // travel
  recentTrips: 'completed_trip',
  bookings: 'booked_trip',
  destinations: 'visited_destination',
  // food
  dietaryRestrictions: 'dietary_restriction',
  favouriteCuisines: 'preference',
  visitedRestaurants: 'visited_restaurant',
  // studio
  recentBookings: 'booked_session',
  instruments: 'requested_instrument',
  genres: 'preference',
  // ai
  recentPrompts: 'said',
  feedback: 'rated',
};
