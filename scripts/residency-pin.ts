/**
 * Pin a tenant's residency on THIS deployment's database (#916 step 3,
 * docs/operations.md § Data residency) — the ops path for provisioning a
 * regional cell, where no tenant is served yet and so no REST call can
 * authenticate through one. Reads the deployment's own SURREALDB_* and
 * BRAIN_REGION from the environment; prints the pin, never data.
 *
 *   pnpm residency:pin <companyId> <region>
 *   pnpm residency:pin --show <companyId>
 */
import { ConfigService } from '@nestjs/config';
import { SurrealService } from '../src/db/surreal.service';
import { REGION_RE } from '../src/db/residency';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const show = args[0] === '--show';
  const [companyId, region] = show ? [args[1], undefined] : args;
  if (!companyId || !/^[a-zA-Z0-9_-]+$/.test(companyId)) {
    throw new Error('usage: residency:pin <companyId> <region> | --show <companyId>');
  }
  const surreal = new SurrealService(new ConfigService(process.env));
  await surreal.onModuleInit();
  try {
    if (!show) {
      const r = region?.trim().toLowerCase() ?? '';
      if (!REGION_RE.test(r)) throw new Error(`"${r}" is not a region name`);
      await surreal.residency.pin(companyId, r, 'ops:residency-pin');
    }
    console.log(
      JSON.stringify({
        companyId,
        region: await surreal.residency.pinOf(companyId),
        deploymentRegion: surreal.residency.region,
      }),
    );
  } finally {
    await surreal.onModuleDestroy();
  }
}

main().catch((e: unknown) => {
  console.error((e as Error).message);
  process.exit(1);
});
