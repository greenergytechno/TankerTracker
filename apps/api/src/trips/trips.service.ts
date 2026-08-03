import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { AuditService } from '../common/audit.service';
import { AuthedUser, Role, depotScopeFor } from '../common/roles';
import { AddExpenseDto, LogStopDto, ScheduleTripDto, StartTripDto, EndTripDto } from './trips.dto';

export interface TripRow {
  id: string;
  trip_ref: string;
  status: string;
  origin: string;
  destination: string;
  max_stops: number;
  load_kl: string;
  deadline_at: Date;
  departure_at: Date | null;
  departure_weight_kg: string | null;
  opening_odometer_km: number | null;
  arrival_at: Date | null;
  arrival_weight_kg: string | null;
  closing_odometer_km: number | null;
  inactivity_threshold_minutes: number;
  invoice_no: string | null;
  driver_phone: string | null;
  registration_no: string;
  driver_name: string;
}

const TRIP_SELECT = `
  SELECT t.id, t.trip_ref, t.status, t.origin, t.destination, t.max_stops,
         t.load_kl, t.deadline_at, t.departure_at, t.departure_weight_kg,
         t.opening_odometer_km, t.arrival_at, t.arrival_weight_kg,
         t.closing_odometer_km, t.inactivity_threshold_minutes,
         t.invoice_no, t.driver_phone,
         v.registration_no, u.full_name AS driver_name
    FROM trips t
    JOIN vehicles v ON v.id = t.vehicle_id
    JOIN users u ON u.id = t.driver_id`;

@Injectable()
export class TripsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /** Least privilege: a driver may only ever reach their own trip. */
  private async loadVisible(tripRef: string, user: AuthedUser): Promise<TripRow> {
    const depotId = depotScopeFor(user);
    const trip = await this.db.one<TripRow>(
      `${TRIP_SELECT}
        WHERE t.trip_ref = $1
          AND ($2::uuid IS NULL OR t.depot_id = $2)
          AND ($3::uuid IS NULL OR t.driver_id = $3)`,
      [tripRef, depotId, user.role === Role.Driver ? user.id : null],
    );
    if (!trip) throw new NotFoundException(`No trip found for ${tripRef}`);
    return trip;
  }

  async schedule(dto: ScheduleTripDto, user: AuthedUser): Promise<TripRow> {
    return this.db.transaction(async (client) => {
      const { rows } = await client.query<{ id: string; trip_ref: string }>(
        `INSERT INTO trips (vehicle_id, driver_id, dispatcher_id, depot_id,
                            origin, destination, max_stops, load_kl, deadline_at,
                            gps_access_point, inactivity_threshold_minutes,
                            invoice_no, driver_phone, advance_minor, expected_return_on)
         SELECT v.id, $2, $3, v.depot_id, $4, $5, $6, $7, $8, $9,
                coalesce($10, 45), $11, $12, coalesce($13, 0), $14
           FROM vehicles v
          WHERE v.id = $1 AND v.status <> 'retired'
         RETURNING id, trip_ref`,
        [
          dto.vehicleId, dto.driverId, user.id, dto.origin, dto.destination,
          dto.maxStops, dto.loadKl, dto.deadlineAt, dto.gpsAccessPoint ?? null,
          dto.inactivityThresholdMinutes ?? null,
          dto.invoiceNo ?? null, dto.driverPhone ?? null,
          dto.advanceMinor ?? null, dto.expectedReturnOn ?? null,
        ],
      );

      if (rows.length === 0) {
        throw new NotFoundException('Vehicle not found or retired');
      }

      await this.audit.record(client, user, {
        action: 'trip.schedule',
        entityType: 'trip',
        entityId: rows[0].id,
        after: { ...dto, tripRef: rows[0].trip_ref },
      });

      const { rows: full } = await client.query<TripRow>(
        `${TRIP_SELECT} WHERE t.id = $1`,
        [rows[0].id],
      );
      return full[0];
    });
  }

  async start(tripRef: string, dto: StartTripDto, user: AuthedUser): Promise<TripRow> {
    const trip = await this.loadVisible(tripRef, user);

    return this.db.transaction(async (client) => {
      const { rows } = await client.query<TripRow>(
        `UPDATE trips
            SET status = 'active', departure_at = $2, departure_weight_kg = $3,
                opening_odometer_km = $4
          WHERE id = $1 AND status = 'scheduled'
          RETURNING id`,
        [trip.id, dto.departureAt, dto.departureWeightKg, dto.openingOdometerKm],
      );
      if (rows.length === 0) {
        throw new ForbiddenException(`Trip ${tripRef} is ${trip.status}, not scheduled`);
      }

      await client.query(`UPDATE vehicles SET status = 'on_trip' WHERE id = (SELECT vehicle_id FROM trips WHERE id = $1)`, [trip.id]);

      await this.audit.record(client, user, {
        action: 'trip.depart',
        entityType: 'trip',
        entityId: trip.id,
        before: { status: trip.status },
        after: dto,
        latitude: dto.latitude ?? null,
        longitude: dto.longitude ?? null,
      });

      const { rows: full } = await client.query<TripRow>(`${TRIP_SELECT} WHERE t.id = $1`, [trip.id]);
      return full[0];
    });
  }

  /**
   * The unauthorised decision is not made here. The insert trigger sets seq,
   * is_unauthorised and the reason list; whatever the handset claims is ignored.
   */
  async logStop(tripRef: string, dto: LogStopDto, user: AuthedUser) {
    const trip = await this.loadVisible(tripRef, user);

    return this.db.transaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO trip_stops (trip_id, location_label, latitude, longitude,
                                 stop_type, occurred_at, odometer_km, notes, logged_by)
         VALUES ($1, $2, $3, $4, $5::stop_type, $6, $7, $8, $9)
         RETURNING id, seq, is_unauthorised, unauthorised_reasons`,
        [
          trip.id, dto.locationLabel, dto.latitude ?? null, dto.longitude ?? null,
          dto.stopType, dto.occurredAt, dto.odometerKm ?? null, dto.notes ?? null, user.id,
        ],
      );

      await this.audit.record(client, user, {
        action: 'trip.stop.log',
        entityType: 'trip_stop',
        entityId: rows[0].id,
        after: rows[0],
        latitude: dto.latitude ?? null,
        longitude: dto.longitude ?? null,
      });

      return rows[0];
    });
  }

  /**
   * The driver's only write path to a trip's money. They can add an expense
   * line but cannot touch the advance, invoice or any scheduling field — those
   * are set at dispatch and have no driver-reachable update route.
   */
  async logExpense(tripRef: string, dto: AddExpenseDto, user: AuthedUser) {
    const trip = await this.loadVisible(tripRef, user);
    // Expenses may only be added to a trip in flight. Once it is completed the
    // settlement sheet is closed; accepting more lines would let a driver
    // inflate an already-reviewed payout (see docs/DESIGN-FLAWS.md #3).
    if (trip.status !== 'active') {
      throw new ForbiddenException(
        `Trip ${tripRef} is ${trip.status}; expenses can only be added while it is active`,
      );
    }

    return this.db.transaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO trip_expenses (trip_id, head, amount_minor, note, bill_id, logged_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, expense_ref, head, amount_minor`,
        [trip.id, dto.head.trim(), dto.amountMinor, dto.note ?? null,
         dto.billId ?? null, user.id],
      );

      await this.audit.record(client, user, {
        action: 'trip.expense.add',
        entityType: 'trip_expense',
        entityId: rows[0].id,
        after: rows[0],
      });

      return rows[0];
    });
  }

  async end(tripRef: string, dto: EndTripDto, user: AuthedUser): Promise<TripRow> {
    const trip = await this.loadVisible(tripRef, user);

    return this.db.transaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `UPDATE trips
            SET status = 'completed', arrival_at = $2, arrival_weight_kg = $3,
                closing_odometer_km = $4, diesel_litres = $5
          WHERE id = $1 AND status = 'active'
          RETURNING id`,
        [trip.id, dto.arrivalAt, dto.arrivalWeightKg, dto.closingOdometerKm,
         dto.dieselLitres ?? null],
      );
      if (rows.length === 0) {
        throw new ForbiddenException(`Trip ${tripRef} is ${trip.status}, not active`);
      }

      await client.query(
        `UPDATE vehicles SET status = 'available'
          WHERE id = (SELECT vehicle_id FROM trips WHERE id = $1)`,
        [trip.id],
      );

      // The closing reading is a real odometer observation, so it belongs in
      // the fuel log too — otherwise trip distance and fleet distance drift.
      await client.query(
        `INSERT INTO fuel_log (vehicle_id, kind, recorded_on, odometer_km, trip_id, logged_by)
         SELECT vehicle_id, 'reading', $2::timestamptz::date, $3, id, $4
           FROM trips WHERE id = $1
         ON CONFLICT (vehicle_id, odometer_km, kind) DO NOTHING`,
        [trip.id, dto.arrivalAt, dto.closingOdometerKm, user.id],
      );

      await this.audit.record(client, user, {
        action: 'trip.complete',
        entityType: 'trip',
        entityId: trip.id,
        after: dto,
        latitude: dto.latitude ?? null,
        longitude: dto.longitude ?? null,
      });

      const { rows: full } = await client.query<TripRow>(`${TRIP_SELECT} WHERE t.id = $1`, [trip.id]);
      return full[0];
    });
  }

  async list(user: AuthedUser, status?: string) {
    const depotId = depotScopeFor(user);
    return this.db.query(
      `${TRIP_SELECT}
        WHERE ($1::uuid IS NULL OR t.depot_id = $1)
          AND ($2::uuid IS NULL OR t.driver_id = $2)
          AND ($3::text IS NULL OR t.status = $3::trip_status)
        ORDER BY t.created_at DESC
        LIMIT 200`,
      [depotId, user.role === Role.Driver ? user.id : null, status ?? null],
    );
  }

  /**
   * The end-of-trip report. Stop classification and inactivity analysis are
   * computed from stored facts rather than recalculated by any client.
   */
  async report(tripRef: string, user: AuthedUser) {
    const trip = await this.loadVisible(tripRef, user);
    if (trip.status !== 'completed') {
      throw new ForbiddenException(`Trip ${tripRef} is not complete`);
    }

    const stops = await this.db.query(
      `SELECT seq, location_label, stop_type, occurred_at, odometer_km,
              is_unauthorised, unauthorised_reasons
         FROM trip_stops WHERE trip_id = $1 ORDER BY seq`,
      [trip.id],
    );

    const gaps = await this.db.query(
      `WITH events AS (
         SELECT departure_at AS at, 'Departure — ' || origin AS label
           FROM trips WHERE id = $1
         UNION ALL
         SELECT occurred_at,
                format('Stop — %s (%s)', location_label, stop_type)
           FROM trip_stops WHERE trip_id = $1
         UNION ALL
         SELECT arrival_at, 'Arrival — ' || destination
           FROM trips WHERE id = $1
       ), ordered AS (
         SELECT at, label,
                lag(at) OVER (ORDER BY at) AS prev_at,
                lag(label) OVER (ORDER BY at) AS prev_label
           FROM events
       )
       SELECT prev_label, prev_at, label, at,
              round(EXTRACT(EPOCH FROM (at - prev_at)) / 60)::int AS gap_minutes
         FROM ordered
        WHERE prev_at IS NOT NULL
          AND at - prev_at >= make_interval(mins => $2::int)
        ORDER BY at`,
      [trip.id, trip.inactivity_threshold_minutes],
    );

    // Expense lines and the computed settlement — the standardised trip sheet.
    const expenses = await this.db.query(
      `SELECT expense_ref, head, amount_minor, note, bill_id
         FROM trip_expenses WHERE trip_id = $1 ORDER BY created_at`,
      [trip.id],
    );
    const settlement = await this.db.one<{
      advance_minor: string;
      expenses_minor: string;
      balance_minor: string;
      distance_km: number | null;
      diesel_litres: string | null;
      mileage_kmpl: string | null;
    }>(`SELECT advance_minor, expenses_minor, balance_minor, distance_km,
               diesel_litres, mileage_kmpl
          FROM trip_settlement WHERE trip_id = $1`, [trip.id]);

    const departure = Number(trip.departure_weight_kg);
    const arrival = Number(trip.arrival_weight_kg);
    const durationMinutes = Math.round(
      (trip.arrival_at!.getTime() - trip.departure_at!.getTime()) / 60000,
    );

    return {
      tripRef: trip.trip_ref,
      vehicle: trip.registration_no,
      driver: trip.driver_name,
      route: { origin: trip.origin, destination: trip.destination },
      durationMinutes,
      onTime: trip.arrival_at! <= trip.deadline_at,
      delivered: {
        departureWeightKg: departure,
        arrivalWeightKg: arrival,
        deliveredKg: departure - arrival,
        scheduledLoadKl: Number(trip.load_kl),
      },
      distance: {
        openingOdometerKm: trip.opening_odometer_km,
        closingOdometerKm: trip.closing_odometer_km,
        distanceKm: trip.closing_odometer_km! - trip.opening_odometer_km!,
      },
      stops,
      unauthorisedStopCount: stops.filter((s) => s.is_unauthorised).length,
      inactivity: { thresholdMinutes: trip.inactivity_threshold_minutes, gaps },
      tripSheet: {
        invoiceNo: trip.invoice_no,
        driverPhone: trip.driver_phone,
        expenses,
        advanceMinor: Number(settlement?.advance_minor ?? 0),
        expensesMinor: Number(settlement?.expenses_minor ?? 0),
        balanceMinor: Number(settlement?.balance_minor ?? 0),
        dieselLitres: settlement?.diesel_litres != null ? Number(settlement.diesel_litres) : null,
        mileageKmpl: settlement?.mileage_kmpl != null ? Number(settlement.mileage_kmpl) : null,
      },
    };
  }
}
