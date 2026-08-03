import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AuthedUser } from './roles';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  latitude?: number | null;
  longitude?: number | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Writes the compliance trail. Always called with the same client as the domain
 * write so a committed change can never lack its audit row.
 */
@Injectable()
export class AuditService {
  async record(
    client: PoolClient,
    actor: AuthedUser,
    entry: AuditEntry,
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_log (actor_id, actor_role, action, entity_type, entity_id,
                              before_state, after_state, latitude, longitude,
                              ip_address, user_agent)
       VALUES ($1, $2::user_role, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        actor.id,
        actor.role,
        entry.action,
        entry.entityType,
        entry.entityId ?? null,
        entry.before === undefined ? null : JSON.stringify(entry.before),
        entry.after === undefined ? null : JSON.stringify(entry.after),
        entry.latitude ?? null,
        entry.longitude ?? null,
        entry.ip ?? null,
        entry.userAgent ?? null,
      ],
    );
  }
}
