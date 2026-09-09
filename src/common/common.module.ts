import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { DebugTraceInterceptor, TraceBufferService } from './debug-trace';
import { ActivityTrackerService } from './activity-tracker.service';
import { InFlightInterceptor } from './in-flight.interceptor';
import { HealthService } from './health.service';

@Global()
@Module({
  providers: [
    TraceBufferService,
    { provide: APP_INTERCEPTOR, useClass: DebugTraceInterceptor },
    ActivityTrackerService,
    { provide: APP_INTERCEPTOR, useClass: InFlightInterceptor },
    // The one readiness definition — exported so the admin cockpit reads the
    // same report /ready answers from, instead of probing on its own.
    HealthService,
  ],
  exports: [TraceBufferService, ActivityTrackerService, HealthService],
})
export class CommonModule {}
