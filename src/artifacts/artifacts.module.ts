import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SurrealModule } from '../db/surreal.module';
import { AuthModule } from '../auth/auth.module';
import { ArtifactsController } from './artifacts.controller';
import { ArtifactsService } from './artifacts.service';

@Module({
  imports: [ConfigModule, SurrealModule, AuthModule],
  controllers: [ArtifactsController],
  providers: [ArtifactsService],
  exports: [ArtifactsService],
})
export class ArtifactsModule {}
