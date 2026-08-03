import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DatabaseService } from '../db/database.service';
import { AuditService } from '../common/audit.service';
import { StorageService } from '../storage/storage.service';
import { AuthedUser } from '../common/roles';
import { CreateMaintenanceDto, MaintenanceQueryDto } from './maintenance.dto';

const ALLOWED_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

@Injectable()
export class MaintenanceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Step one of two. The bill is stored and registered before any maintenance
   * record can reference it — maintenance_records.bill_id is NOT NULL, so a
   * record without evidence is rejected by the database, not by a UI check.
   */
  async uploadBill(
    file: { buffer: Buffer; originalname: string; mimetype: string; size: number },
    user: AuthedUser,
  ) {
    if (!ALLOWED_TYPES.has(file.mimetype)) {
      throw new BadRequestException('A bill must be a PDF, JPEG, PNG or WebP file.');
    }

    const checksum = createHash('sha256').update(file.buffer).digest('hex');

    // Deduplicate before spending a storage round trip on a file we already hold.
    const existing = await this.db.one<{ id: string; original_filename: string }>(
      `SELECT id, original_filename FROM maintenance_bills WHERE checksum_sha256 = $1`,
      [checksum],
    );
    if (existing) {
      throw new BadRequestException(
        `That exact file is already on record as ${existing.original_filename}.`,
      );
    }

    const objectKey = this.storage.buildBillKey(checksum, file.originalname);
    await this.storage.put(objectKey, file.buffer, file.mimetype);

    return this.db.transaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO maintenance_bills (object_key, original_filename, content_type,
                                        size_bytes, checksum_sha256, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, object_key, original_filename, size_bytes, uploaded_at`,
        [objectKey, file.originalname, file.mimetype, file.size, checksum, user.id],
      );

      await this.audit.record(client, user, {
        action: 'maintenance.bill.upload',
        entityType: 'maintenance_bill',
        entityId: rows[0].id,
        after: { objectKey, checksum, size: file.size },
      });

      return rows[0];
    });
  }

  /** Step two. Fails at the database if billId is absent or already used. */
  async create(dto: CreateMaintenanceDto, user: AuthedUser) {
    return this.db.transaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO maintenance_records
           (vehicle_id, category, description, vendor_name, invoice_no, serviced_on,
            odometer_km, amount_minor, gst_bps, payment_status, next_due_on,
            bill_id, created_by)
         VALUES ($1, $2::maintenance_category, $3, $4, $5, $6, $7, $8, $9,
                 $10::payment_status, $11, $12, $13)
         RETURNING id, record_ref, total_minor`,
        [
          dto.vehicleId, dto.category, dto.description, dto.vendorName, dto.invoiceNo,
          dto.servicedOn, dto.odometerKm ?? null, dto.amountMinor, dto.gstBps ?? 1800,
          dto.paymentStatus, dto.nextDueOn ?? null, dto.billId, user.id,
        ],
      );

      await this.audit.record(client, user, {
        action: 'maintenance.record.create',
        entityType: 'maintenance_record',
        entityId: rows[0].id,
        after: { ...dto, recordRef: rows[0].record_ref },
      });

      return rows[0];
    });
  }

  async list(query: MaintenanceQueryDto) {
    return this.db.query(
      `SELECT m.record_ref, v.registration_no, m.category, m.description,
              m.vendor_name, m.invoice_no, m.serviced_on, m.odometer_km,
              m.amount_minor, m.gst_bps, m.total_minor, m.payment_status,
              m.next_due_on, b.original_filename AS bill_filename
         FROM maintenance_records m
         JOIN vehicles v ON v.id = m.vehicle_id
         JOIN maintenance_bills b ON b.id = m.bill_id
        WHERE ($1::uuid IS NULL OR m.vehicle_id = $1)
          AND ($2::text IS NULL OR m.category = $2::maintenance_category)
          AND ($3::text IS NULL OR m.payment_status = $3::payment_status)
          AND ($4::text IS NULL OR m.vendor_name ILIKE '%' || $4 || '%'
                                OR m.invoice_no ILIKE '%' || $4 || '%')
        ORDER BY m.serviced_on DESC, m.created_at DESC
        LIMIT $5`,
      [
        query.vehicleId ?? null,
        query.category ?? null,
        query.paymentStatus ?? null,
        query.search ?? null,
        query.limit ?? 200,
      ],
    );
  }

  /** Powers the manager's spend tiles. Aggregated in the database, not in JS. */
  async summary() {
    const [totals] = await this.db.query<{
      total_minor: string;
      last_30_days_minor: string;
      outstanding_minor: string;
      unpaid_count: string;
      gst_minor: string;
      record_count: string;
      vehicles_serviced: string;
      due_in_30_days: string;
    }>(
      `SELECT
         coalesce(sum(total_minor), 0)::text AS total_minor,
         coalesce(sum(total_minor) FILTER (WHERE serviced_on >= CURRENT_DATE - 30), 0)::text
           AS last_30_days_minor,
         coalesce(sum(total_minor) FILTER (WHERE payment_status <> 'paid'), 0)::text
           AS outstanding_minor,
         count(*) FILTER (WHERE payment_status <> 'paid')::text AS unpaid_count,
         coalesce(sum(total_minor - amount_minor), 0)::text AS gst_minor,
         count(*)::text AS record_count,
         count(DISTINCT vehicle_id)::text AS vehicles_serviced,
         count(*) FILTER (WHERE next_due_on IS NOT NULL
                            AND next_due_on <= CURRENT_DATE + 30)::text AS due_in_30_days
       FROM maintenance_records`,
    );

    const byCategory = await this.db.query(
      `SELECT category, sum(total_minor)::text AS total_minor
         FROM maintenance_records GROUP BY category ORDER BY sum(total_minor) DESC`,
    );

    const byVehicle = await this.db.query(
      `SELECT v.registration_no, sum(m.total_minor)::text AS total_minor
         FROM maintenance_records m JOIN vehicles v ON v.id = m.vehicle_id
        GROUP BY v.registration_no ORDER BY sum(m.total_minor) DESC`,
    );

    const dueSoon = await this.db.query(
      `SELECT v.registration_no, m.category, m.next_due_on,
              (m.next_due_on - CURRENT_DATE) AS days_remaining
         FROM maintenance_records m JOIN vehicles v ON v.id = m.vehicle_id
        WHERE m.next_due_on IS NOT NULL
        ORDER BY m.next_due_on
        LIMIT 20`,
    );

    return { totals, byCategory, byVehicle, dueSoon };
  }

  /** Short-lived presigned link; bill scans are never served from the API. */
  async billDownloadUrl(recordRef: string) {
    const row = await this.db.one<{ object_key: string; original_filename: string }>(
      `SELECT b.object_key, b.original_filename
         FROM maintenance_records m JOIN maintenance_bills b ON b.id = m.bill_id
        WHERE m.record_ref = $1`,
      [recordRef],
    );
    if (!row) throw new NotFoundException(`No maintenance record ${recordRef}`);

    return {
      filename: row.original_filename,
      url: await this.storage.presignedGetUrl(row.object_key, 300),
      expiresInSeconds: 300,
    };
  }
}
