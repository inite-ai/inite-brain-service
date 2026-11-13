import { Module } from '@nestjs/common';
import { DATA_MIGRATIONS, type DataMigration } from './data-migration';
import { DataMigrationRunnerService } from './data-migration-runner.service';
import { EdgeResolutionCheckedMigration } from './edge-resolution-checked.migration';
import { EdgeValidFromCreatedMigration } from './edge-valid-from-created.migration';
import { EdgeValidUntilFromInvalidatedMigration } from './edge-valid-until-from-invalidated.migration';

/**
 * Data migrations: row fixes kept out of the schema migrations (see
 * data-migration.ts). A new one is a class implementing DataMigration
 * (usually extending IdBatchMigration), listed as a provider and in the
 * DATA_MIGRATIONS `inject` below — the runner never names one. The order
 * of `inject` is the run order within a tenant.
 */
@Module({
  providers: [
    EdgeValidUntilFromInvalidatedMigration,
    EdgeResolutionCheckedMigration,
    EdgeValidFromCreatedMigration,
    {
      provide: DATA_MIGRATIONS,
      useFactory: (...migrations: DataMigration[]): DataMigration[] => migrations,
      inject: [
        // First: it closes pre-0164 edges on the valid-time axis, which the
        // two below read.
        EdgeValidUntilFromInvalidatedMigration,
        EdgeResolutionCheckedMigration,
        EdgeValidFromCreatedMigration,
      ],
    },
    DataMigrationRunnerService,
  ],
  exports: [DataMigrationRunnerService],
})
export class DataMigrationsModule {}
