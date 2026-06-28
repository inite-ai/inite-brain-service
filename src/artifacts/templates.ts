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
const addSingle = ({
  compiled,
  facts,
  fieldName,
  predicate,
}: {
  compiled: CompiledArtifact;
  facts: FactRow[];
  fieldName: string;
  predicate: string;
}): string | undefined => {
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
const addList = ({
  compiled,
  facts,
  fieldName,
  predicate,
  topN,
}: {
  compiled: CompiledArtifact;
  facts: FactRow[];
  fieldName: string;
  predicate: string;
  topN: number;
}) => {
  const subset = allOf(facts, predicate).slice(0, topN);
  if (subset.length === 0) return;
  compiled.payload[fieldName] = subset.map((f) => f.object);
  compiled.citations[fieldName] = subset.map(cite);
  for (const f of subset) compiled.sourceFactIds.push(String(f.id));
};

// ─── Generic templates (work for any vertical) ───────────────────

const customerProfile: Template = (facts) => {
  const c = empty();
  addSingle({ compiled: c, facts, fieldName: 'name', predicate: 'name' });
  addSingle({ compiled: c, facts, fieldName: 'tier', predicate: 'tier' });
  addSingle({ compiled: c, facts, fieldName: 'status', predicate: 'status' });
  addSingle({ compiled: c, facts, fieldName: 'email', predicate: 'email' });
  addSingle({ compiled: c, facts, fieldName: 'phone', predicate: 'phone' });
  addList({ compiled: c, facts, fieldName: 'recentInteractions', predicate: 'interacted_with', topN: 5 });
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
  addSingle({ compiled: c, facts, fieldName: 'name', predicate: 'name' });
  addSingle({ compiled: c, facts, fieldName: 'tier', predicate: 'tier' });
  addSingle({ compiled: c, facts, fieldName: 'status', predicate: 'status' });
  addList({ compiled: c, facts, fieldName: 'rentalHistory', predicate: 'rented_vehicle', topN: 10 });
  addList({ compiled: c, facts, fieldName: 'paymentEvents', predicate: 'paid_invoice', topN: 10 });
  addList({ compiled: c, facts, fieldName: 'incidents', predicate: 'reported_incident', topN: 5 });
  addList({ compiled: c, facts, fieldName: 'preferences', predicate: 'preference', topN: 5 });
  return c;
};

/** inite.estate — listing card for property listings. */
const listingCard: Template = (facts) => {
  const c = empty();
  addSingle({ compiled: c, facts, fieldName: 'title', predicate: 'name' });
  addSingle({ compiled: c, facts, fieldName: 'price', predicate: 'listed_price' });
  addSingle({ compiled: c, facts, fieldName: 'status', predicate: 'status' });
  addSingle({ compiled: c, facts, fieldName: 'bedrooms', predicate: 'bedrooms' });
  addSingle({ compiled: c, facts, fieldName: 'bathrooms', predicate: 'bathrooms' });
  addSingle({ compiled: c, facts, fieldName: 'floorArea', predicate: 'floor_area' });
  addList({ compiled: c, facts, fieldName: 'amenities', predicate: 'amenity', topN: 20 });
  addList({ compiled: c, facts, fieldName: 'recentViewings', predicate: 'viewed_by', topN: 10 });
  return c;
};

/** inite.estate — prospect summary for buyers/renters interested in listings. */
const prospectSummary: Template = (facts) => {
  const c = empty();
  addSingle({ compiled: c, facts, fieldName: 'name', predicate: 'name' });
  addSingle({ compiled: c, facts, fieldName: 'budget', predicate: 'budget' });
  addSingle({ compiled: c, facts, fieldName: 'desiredArea', predicate: 'desired_area' });
  addList({ compiled: c, facts, fieldName: 'viewedListings', predicate: 'viewed_listing', topN: 10 });
  addList({ compiled: c, facts, fieldName: 'preferences', predicate: 'preference', topN: 10 });
  addList({ compiled: c, facts, fieldName: 'objections', predicate: 'complained_about', topN: 5 });
  return c;
};

/** inite.events — attendee history (concerts, classes, conferences). */
const attendeeHistory: Template = (facts) => {
  const c = empty();
  addSingle({ compiled: c, facts, fieldName: 'name', predicate: 'name' });
  addSingle({ compiled: c, facts, fieldName: 'tier', predicate: 'tier' });
  addList({ compiled: c, facts, fieldName: 'attendedEvents', predicate: 'attended_event', topN: 20 });
  addList({ compiled: c, facts, fieldName: 'purchasedTickets', predicate: 'purchased_ticket', topN: 10 });
  addList({ compiled: c, facts, fieldName: 'preferences', predicate: 'preference', topN: 5 });
  return c;
};

/** inite.health — patient summary (heavy PII; per-field gating active). */
const patientSummary: Template = (facts) => {
  const c = empty();
  addSingle({ compiled: c, facts, fieldName: 'name', predicate: 'name' });
  addSingle({ compiled: c, facts, fieldName: 'dob', predicate: 'dob' });
  addSingle({ compiled: c, facts, fieldName: 'status', predicate: 'status' });
  addList({ compiled: c, facts, fieldName: 'medications', predicate: 'prescribed_medication', topN: 20 });
  addList({ compiled: c, facts, fieldName: 'allergies', predicate: 'has_allergy', topN: 10 });
  addList({ compiled: c, facts, fieldName: 'recentAppointments', predicate: 'attended_appointment', topN: 10 });
  addList({ compiled: c, facts, fieldName: 'recentTreatments', predicate: 'received_treatment', topN: 10 });
  addList({ compiled: c, facts, fieldName: 'concerns', predicate: 'complained_about', topN: 5 });
  return c;
};

/** inite.shop — order history with LTV. */
const orderHistory: Template = (facts) => {
  const c = empty();
  addSingle({ compiled: c, facts, fieldName: 'name', predicate: 'name' });
  addSingle({ compiled: c, facts, fieldName: 'tier', predicate: 'tier' });
  addSingle({ compiled: c, facts, fieldName: 'status', predicate: 'status' });
  addList({ compiled: c, facts, fieldName: 'recentOrders', predicate: 'placed_order', topN: 20 });
  addList({ compiled: c, facts, fieldName: 'returns', predicate: 'returned_item', topN: 10 });
  addList({ compiled: c, facts, fieldName: 'reviews', predicate: 'reviewed_product', topN: 10 });
  return c;
};

/** inite.club — community member profile. */
const memberProfile: Template = (facts) => {
  const c = empty();
  addSingle({ compiled: c, facts, fieldName: 'name', predicate: 'name' });
  addSingle({ compiled: c, facts, fieldName: 'tier', predicate: 'tier' });
  addSingle({ compiled: c, facts, fieldName: 'joinDate', predicate: 'joined_at' });
  addList({ compiled: c, facts, fieldName: 'attendedMeetups', predicate: 'attended_meetup', topN: 10 });
  addList({ compiled: c, facts, fieldName: 'contributions', predicate: 'contributed_to', topN: 10 });
  addList({ compiled: c, facts, fieldName: 'interests', predicate: 'interested_in', topN: 10 });
  return c;
};

/** inite.education — learner progress (courses, grades, AI tutor notes). */
const learnerProgress: Template = (facts) => {
  const c = empty();
  addSingle({ compiled: c, facts, fieldName: 'name', predicate: 'name' });
  addSingle({ compiled: c, facts, fieldName: 'currentLevel', predicate: 'level' });
  addList({ compiled: c, facts, fieldName: 'enrolledCourses', predicate: 'enrolled_in', topN: 10 });
  addList({ compiled: c, facts, fieldName: 'completedCourses', predicate: 'completed_course', topN: 20 });
  addList({ compiled: c, facts, fieldName: 'recentScores', predicate: 'scored', topN: 10 });
  addList({ compiled: c, facts, fieldName: 'tutorNotes', predicate: 'said', topN: 10 });
  addList({ compiled: c, facts, fieldName: 'strugglingTopics', predicate: 'complained_about', topN: 5 });
  return c;
};

/** inite.sport — athlete card (training, performance, team). */
const athleteCard: Template = (facts) => {
  const c = empty();
  addSingle({ compiled: c, facts, fieldName: 'name', predicate: 'name' });
  addSingle({ compiled: c, facts, fieldName: 'team', predicate: 'plays_for' });
  addSingle({ compiled: c, facts, fieldName: 'position', predicate: 'plays_position' });
  addList({ compiled: c, facts, fieldName: 'recentMatches', predicate: 'played_match', topN: 10 });
  addList({ compiled: c, facts, fieldName: 'trainingSessions', predicate: 'attended_training', topN: 10 });
  addList({ compiled: c, facts, fieldName: 'achievements', predicate: 'achieved', topN: 10 });
  return c;
};

/** inite.travel — traveler history (trips, preferences). */
const travelerHistory: Template = (facts) => {
  const c = empty();
  addSingle({ compiled: c, facts, fieldName: 'name', predicate: 'name' });
  addSingle({ compiled: c, facts, fieldName: 'tier', predicate: 'tier' });
  addList({ compiled: c, facts, fieldName: 'recentTrips', predicate: 'completed_trip', topN: 10 });
  addList({ compiled: c, facts, fieldName: 'bookings', predicate: 'booked_trip', topN: 10 });
  addList({ compiled: c, facts, fieldName: 'destinations', predicate: 'visited_destination', topN: 20 });
  addList({ compiled: c, facts, fieldName: 'preferences', predicate: 'preference', topN: 10 });
  return c;
};

/** inite.food — diner preferences (cuisine, dietary, ordering history). */
const dinerPreferences: Template = (facts) => {
  const c = empty();
  addSingle({ compiled: c, facts, fieldName: 'name', predicate: 'name' });
  addList({ compiled: c, facts, fieldName: 'dietaryRestrictions', predicate: 'dietary_restriction', topN: 10 });
  addList({ compiled: c, facts, fieldName: 'favouriteCuisines', predicate: 'preference', topN: 10 });
  addList({ compiled: c, facts, fieldName: 'recentOrders', predicate: 'placed_order', topN: 10 });
  addList({ compiled: c, facts, fieldName: 'visitedRestaurants', predicate: 'visited_restaurant', topN: 10 });
  return c;
};

/** inite.studio — booking history for studio rentals. */
const studioBookings: Template = (facts) => {
  const c = empty();
  addSingle({ compiled: c, facts, fieldName: 'name', predicate: 'name' });
  addList({ compiled: c, facts, fieldName: 'recentBookings', predicate: 'booked_session', topN: 10 });
  addList({ compiled: c, facts, fieldName: 'instruments', predicate: 'requested_instrument', topN: 5 });
  addList({ compiled: c, facts, fieldName: 'genres', predicate: 'preference', topN: 5 });
  return c;
};

/** inite.ai — usage and feedback for an AI agent end-user. */
const aiUserContext: Template = (facts) => {
  const c = empty();
  addSingle({ compiled: c, facts, fieldName: 'name', predicate: 'name' });
  addSingle({ compiled: c, facts, fieldName: 'plan', predicate: 'tier' });
  addList({ compiled: c, facts, fieldName: 'recentPrompts', predicate: 'said', topN: 20 });
  addList({ compiled: c, facts, fieldName: 'feedback', predicate: 'rated', topN: 10 });
  addList({ compiled: c, facts, fieldName: 'preferences', predicate: 'preference', topN: 10 });
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
