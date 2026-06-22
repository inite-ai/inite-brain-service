-- 0032_forgotten_entity_audit_fields — GDPR accountability + erasure scope.
--
-- forgotten_entity is SCHEMAFULL, so unknown sub-fields are dropped
-- silently. The forget() path now (a) purges the audit_event mirror that
-- previously left an erased subject reconstructable indefinitely, and
-- (b) records WHO performed the erasure (Art. 5(2)/30 accountability).
-- Declare the two new fields so they actually persist.

DEFINE FIELD IF NOT EXISTS auditEventsDeleted ON forgotten_entity TYPE int DEFAULT 0;
-- Hashed acting credential (req.brainAuth.keyHash). 'unknown' when the
-- erasure was triggered by a path that didn't plumb the principal.
DEFINE FIELD IF NOT EXISTS forgottenBy        ON forgotten_entity TYPE string DEFAULT 'unknown';
