import { Module } from '@nestjs/common';
import { TripsController } from './trips.controller';
import { TripsService } from './trips.service';
import { DatabaseService } from '../db/database.service';
import { AuditService } from '../common/audit.service';

@Module({
  controllers: [TripsController],
  providers: [TripsService, DatabaseService, AuditService],
})
export class TripsModule {}
