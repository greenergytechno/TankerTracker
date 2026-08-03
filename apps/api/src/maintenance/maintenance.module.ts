import { Module } from '@nestjs/common';
import { MaintenanceController } from './maintenance.controller';
import { MaintenanceService } from './maintenance.service';
import { DatabaseService } from '../db/database.service';
import { AuditService } from '../common/audit.service';
import { StorageService } from '../storage/storage.service';

@Module({
  controllers: [MaintenanceController],
  providers: [MaintenanceService, DatabaseService, AuditService, StorageService],
})
export class MaintenanceModule {}
