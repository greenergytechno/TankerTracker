import {
  IsDateString,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export const STOP_TYPES = ['scheduled', 'fuel', 'break', 'unscheduled'] as const;
export type StopType = (typeof STOP_TYPES)[number];

export class ScheduleTripDto {
  @IsUUID() vehicleId!: string;
  @IsUUID() driverId!: string;

  @IsString() @MaxLength(120) origin!: string;
  @IsString() @MaxLength(120) destination!: string;

  @IsInt() @Min(0) maxStops!: number;
  @IsNumber() @IsPositive() loadKl!: number;
  @IsDateString() deadlineAt!: string;

  @IsOptional() @IsString() @MaxLength(200) gpsAccessPoint?: string;

  /** Overrides the 45-minute default for long highway legs. */
  @IsOptional() @IsInt() @Min(5) inactivityThresholdMinutes?: number;

  // Trip-sheet fields the manager fixes at dispatch. The driver settles against
  // these but cannot change them — enforced by the driver-only expense route
  // being the only write path a driver has to a trip's money.
  @IsOptional() @IsString() @MaxLength(60) invoiceNo?: string;
  @IsOptional() @IsString() @MaxLength(20) driverPhone?: string;
  /** Advance paid to the driver, in paise. */
  @IsOptional() @IsInt() @Min(0) advanceMinor?: number;
  @IsOptional() @IsDateString() expectedReturnOn?: string;
}

export class AddExpenseDto {
  /** Free text: the standard heads plus any one-off the driver names. */
  @IsString() @MaxLength(60) head!: string;
  /** Paise. Integer money only. */
  @IsInt() @IsPositive() amountMinor!: number;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
  /** Optional receipt, already uploaded via the bills endpoint. */
  @IsOptional() @IsUUID() billId?: string;
}

export class StartTripDto {
  @IsNumber() @IsPositive() departureWeightKg!: number;
  @IsDateString() departureAt!: string;

  /** Required. The trip cannot go active without it — see trip_active_needs_departure. */
  @IsInt() @Min(0) openingOdometerKm!: number;

  @IsOptional() @IsLatitude() latitude?: number;
  @IsOptional() @IsLongitude() longitude?: number;
}

export class LogStopDto {
  @IsString() @MaxLength(200) locationLabel!: string;
  @IsIn(STOP_TYPES) stopType!: StopType;
  @IsDateString() occurredAt!: string;

  @IsOptional() @IsInt() @Min(0) odometerKm?: number;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @IsOptional() @IsLatitude() latitude?: number;
  @IsOptional() @IsLongitude() longitude?: number;

  // Deliberately absent: is_unauthorised. The database decides that, and a
  // field here would imply the client has a say.
}

export class EndTripDto {
  @IsNumber() @Min(0) arrivalWeightKg!: number;
  @IsDateString() arrivalAt!: string;

  /** Required, and must exceed the opening reading — see trip_odometer_advances. */
  @IsInt() @Min(0) closingOdometerKm!: number;

  /** Diesel used this trip, in litres — feeds this trip's mileage. Not cash. */
  @IsOptional() @IsNumber() @IsPositive() dieselLitres?: number;

  @IsOptional() @IsLatitude() latitude?: number;
  @IsOptional() @IsLongitude() longitude?: number;
}
