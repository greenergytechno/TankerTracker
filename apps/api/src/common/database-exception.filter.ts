import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { DatabaseError } from 'pg';

/**
 * The schema is the authority on what is legal, so its rejections have to reach
 * the client as meaningful errors rather than a blanket 500. Constraint names
 * are mapped deliberately — an unmapped violation stays a 500 on purpose, so a
 * new constraint cannot silently start returning 400 with a leaked message.
 */
const CONSTRAINT_MESSAGES: Record<string, string> = {
  // trips
  trip_endpoints_differ: 'Origin and destination cannot be the same.',
  trip_arrival_after_departure: 'Arrival must be after departure.',
  trip_cannot_gain_weight: 'Arrival weight cannot exceed departure weight.',
  trip_active_needs_departure: 'A trip cannot be active without departure details.',
  trip_completed_needs_arrival: 'A trip cannot be completed without arrival details.',
  trip_cancelled_needs_reason: 'Cancelling a trip requires a reason.',
  trips_one_open_per_vehicle_idx: 'That vehicle already has an open trip.',
  trips_one_open_per_driver_idx: 'That driver already has an open trip.',

  // stops
  stop_seq_unique: 'A stop with that sequence already exists for this trip.',
  stop_latlng_paired: 'Latitude and longitude must be supplied together.',

  // maintenance
  maintenance_invoice_unique_per_vendor:
    'That invoice number is already recorded against this vendor.',
  maintenance_next_due_after_service:
    'Next service due cannot be before the service date.',
  maintenance_bills_checksum_idx:
    'That exact bill file has already been uploaded.',
  bill_content_type_allowed: 'A bill must be a PDF, JPEG, PNG or WebP file.',

  // users
  depot_required_for_scoped_roles: 'Drivers and dispatchers must belong to a depot.',
  driver_needs_hazmat_licence:
    'A driver must hold a licence number and a current hazmat endorsement.',
};

/** Postgres error codes worth translating. */
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const NOT_NULL_VIOLATION = '23502';
const CHECK_VIOLATION = '23514';
const INSUFFICIENT_PRIVILEGE = '42501';
const RAISE_EXCEPTION = 'P0001';

@Catch(DatabaseError)
export class DatabaseExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger(DatabaseExceptionFilter.name);

  catch(error: DatabaseError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, message } = this.translate(error);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.log.error(`Unmapped database error ${error.code}: ${error.message}`, error.stack);
    }

    response.status(status).json({
      statusCode: status,
      error: HttpException.createBody({}, '', status).error ?? 'Error',
      message,
    });
  }

  private translate(error: DatabaseError): { status: number; message: string } {
    const named = error.constraint ? CONSTRAINT_MESSAGES[error.constraint] : undefined;

    switch (error.code) {
      case UNIQUE_VIOLATION:
        return { status: HttpStatus.CONFLICT, message: named ?? 'That record already exists.' };

      case CHECK_VIOLATION:
        return { status: HttpStatus.BAD_REQUEST, message: named ?? 'The request violates a business rule.' };

      case NOT_NULL_VIOLATION:
        // The one that matters: a maintenance record with no bill attached.
        if (error.column === 'bill_id') {
          return {
            status: HttpStatus.BAD_REQUEST,
            message: 'A maintenance record cannot be saved without an attached bill.',
          };
        }
        return { status: HttpStatus.BAD_REQUEST, message: `Missing required field: ${error.column}.` };

      case FOREIGN_KEY_VIOLATION:
        return { status: HttpStatus.BAD_REQUEST, message: 'A referenced record does not exist.' };

      case INSUFFICIENT_PRIVILEGE:
        // Raised by the append-only triggers on trip_stops and audit_log.
        return { status: HttpStatus.FORBIDDEN, message: error.message };

      case RAISE_EXCEPTION:
        return { status: HttpStatus.BAD_REQUEST, message: error.message };

      default:
        return {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'Internal server error',
        };
    }
  }
}
