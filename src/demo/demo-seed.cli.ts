/**
 * One-off: load the demo pack into the demo tenant.
 *
 *   node dist/demo/demo-seed.cli.js                         # dry run: what would be written
 *   DEMO_SEED_WRITE=1 node dist/demo/demo-seed.cli.js --apply
 *
 * Opens only the SurrealDB pool (ConfigModule + SurrealModule): no HTTP
 * server, no job loop, no model client. Refuses any `--tenant` other than
 * DEMO_ORG_ID before it connects. Safe to run on production and safe to
 * run twice (demo-seed.ts).
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { SurrealModule } from '../db/surreal.module';
import { SurrealService } from '../db/surreal.service';
import { ATLANTICA_DEMO_PACK } from './atlantica-pack';
import {
  applyDemoSeed,
  assertDemoTenant,
  parseSeedArgs,
  summarize,
  validateDemoPack,
} from './demo-seed';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env.local', '.env'] }),
    SurrealModule,
  ],
})
class DemoSeedModule {}

async function main(): Promise<void> {
  const args = parseSeedArgs(process.argv.slice(2), process.env);
  const tenant = assertDemoTenant(args.tenant);
  const problems = validateDemoPack(ATLANTICA_DEMO_PACK);
  if (problems.length > 0) throw new Error(`demo pack is not whole: ${problems.join('; ')}`);
  if (!args.apply) {
    console.log(JSON.stringify({ dryRun: true, ...summarize(ATLANTICA_DEMO_PACK, tenant) }));
    console.log('dry run: nothing written. Write with DEMO_SEED_WRITE=1 and --apply.');
    return;
  }
  const app = await NestFactory.createApplicationContext(DemoSeedModule, {
    logger: ['error', 'warn'],
  });
  try {
    const surreal = app.get(SurrealService);
    const summary = await surreal.withCompany(tenant, (db) => applyDemoSeed(db, tenant));
    console.log(JSON.stringify({ dryRun: false, ...summary }));
  } finally {
    await app.close();
  }
}

main().catch((e: unknown) => {
  console.error(`[demo-seed] ${(e as Error).message}`);
  process.exit(1);
});
