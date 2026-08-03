import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { DatabaseModule } from './db/database.module';
import { AuthModule } from './auth/auth.module';
import { TripsModule } from './trips/trips.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { loadEnv } from './config/env';

const env = loadEnv();

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    ThrottlerModule.forRoot([
      { ttl: env.RATE_LIMIT_TTL_SECONDS * 1000, limit: env.RATE_LIMIT_MAX },
    ]),
    DatabaseModule,
    AuthModule,
    TripsModule,
    MaintenanceModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
