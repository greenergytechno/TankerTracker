import { Inject, Injectable } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { PG_POOL } from './database.module';

export interface RequestContext {
  userId: string;
  role: string;
  ip?: string;
  userAgent?: string;
  latitude?: number;
  longitude?: number;
}

@Injectable()
export class DatabaseService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async query<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.pool.query<T>(sql, params);
    return result.rows;
  }

  async one<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  /**
   * Runs work inside a transaction. Anything that writes a domain row and its
   * audit entry must go through here so the two cannot diverge.
   */
  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Money and weights come back as strings; convert only where it is safe. */
  static toNumber(value: string | null): number | null {
    return value === null ? null : Number(value);
  }
}
