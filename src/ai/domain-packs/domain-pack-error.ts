/**
 * A manifest that fails validation: answered as a 400 rather than a raw
 * store error. Its own module because validate.ts and the section
 * validators it calls (validate-memory-model.ts, validate-sources.ts) all
 * throw it.
 */
export class DomainPackError extends Error {}
