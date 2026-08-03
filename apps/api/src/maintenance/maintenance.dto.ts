import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const MAINTENANCE_CATEGORIES = [
  'preventive_service', 'engine_transmission', 'tyres_wheels', 'brakes_suspension',
  'electrical_battery', 'body_cabin', 'tanker_barrel_manhole', 'valves_hoses_seals',
  'pump_metering_unit', 'safety_equipment_hazmat', 'tank_calibration_certification',
  'statutory_fc_puc_permit', 'insurance', 'breakdown_roadside', 'accident_repair',
] as const;

export const PAYMENT_STATUSES = ['paid', 'unpaid', 'part_paid'] as const;

export class CreateMaintenanceDto {
  @IsUUID() vehicleId!: string;

  @IsIn(MAINTENANCE_CATEGORIES)
  category!: (typeof MAINTENANCE_CATEGORIES)[number];

  @IsString() @MaxLength(500) description!: string;
  @IsString() @MaxLength(200) vendorName!: string;
  @IsString() @MaxLength(60) invoiceNo!: string;

  @IsDateString() servicedOn!: string;

  @IsOptional() @IsInt() @Min(0) odometerKm?: number;

  /** Paise. Integer money only — no floats anywhere in the cost path. */
  @IsInt() @Min(1) amountMinor!: number;

  /** Basis points: 1800 = 18.00%. */
  @IsOptional() @IsInt() @Min(0) @Max(10000) gstBps?: number;

  @IsIn(PAYMENT_STATUSES) paymentStatus!: (typeof PAYMENT_STATUSES)[number];

  @IsOptional() @IsDateString() nextDueOn?: string;

  /** Must reference an already-uploaded bill. Enforced NOT NULL by the schema. */
  @IsUUID() billId!: string;
}

export class MaintenanceQueryDto {
  @IsOptional() @IsUUID() vehicleId?: string;
  @IsOptional() @IsIn(MAINTENANCE_CATEGORIES) category?: string;
  @IsOptional() @IsIn(PAYMENT_STATUSES) paymentStatus?: string;
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsInt() @Min(1) @Max(500) limit?: number;
}
