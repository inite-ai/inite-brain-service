import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChildTenantsController } from './child-tenants.controller';
import { ChildTenantsService } from './child-tenants.service';

/** Child tenants of a product's machine client (ADR 0001). */
@Module({
  imports: [AuthModule],
  controllers: [ChildTenantsController],
  providers: [ChildTenantsService],
})
export class TenantsModule {}
