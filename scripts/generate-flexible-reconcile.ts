/**
 * Regenerate src/db/migrations/0135_flexible_reconcile.surql from the
 * FLEXIBLE declarations in the migrations before it. See
 * src/db/flexible-fields.ts for why the file is derived, never typed.
 *
 *   pnpm migrations:flexible
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectFlexibleFields, renderFlexibleReconcile } from '../src/db/flexible-fields';

export const RECONCILE_MIGRATION = '0135_flexible_reconcile.surql';

const dir = join(__dirname, '..', 'src', 'db', 'migrations');
const declarations = collectFlexibleFields(dir);
const out = join(dir, RECONCILE_MIGRATION);
writeFileSync(out, renderFlexibleReconcile(declarations), 'utf8');
console.info(`wrote ${RECONCILE_MIGRATION}: ${declarations.length} FLEXIBLE field(s)`);
