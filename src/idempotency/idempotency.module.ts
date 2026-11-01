import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IdempotencyStoreService } from './idempotency-store.service';

/**
 * Idempotency-Key on every authenticated write (0179). SurrealService,
 * ApiKeyService and the lease guard come from global modules.
 */
@Module({
  providers: [
    IdempotencyStoreService,
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
  exports: [IdempotencyStoreService],
})
export class IdempotencyModule {}
