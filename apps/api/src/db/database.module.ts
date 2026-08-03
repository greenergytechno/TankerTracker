import {
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { Pool, types } from 'pg';
import { loadEnv } from '../config/env';

export const PG_POOL = Symbol('PG_POOL');

/**
 * numeric/int8 arrive as strings from node-postgres because they can exceed
 * IEEE-754 range. Weights and money are read deliberately below rather than
 * globally coerced — see DatabaseService.toNumber / toBigInt.
 */
types.setTypeParser(types.builtins.INT8, (v) => v);
types.setTypeParser(types.builtins.NUMERIC, (v) => v);

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: (): Pool => {
        const env = loadEnv();
        return new Pool({
          connectionString: env.DATABASE_URL,
          max: env.DATABASE_POOL_MAX,
          ssl: env.DATABASE_SSL === 'require' ? { rejectUnauthorized: true } : undefined,
          application_name: 'tankertrack-api',
          statement_timeout: 15_000,
        });
      },
    },
  ],
  exports: [PG_POOL],
})
export class DatabaseModule implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger(DatabaseModule.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * The database is a hard dependency. If it is unreachable, or the schema has
   * not been migrated, the process exits instead of accepting traffic it cannot
   * serve correctly.
   */
  async onModuleInit(): Promise<void> {
    const client = await this.pool.connect().catch((cause: unknown) => {
      throw new Error(
        `Cannot reach PostgreSQL. The API requires a database and will not start without one. ${String(cause)}`,
      );
    });

    try {
      const { rows } = await client.query<{ present: boolean }>(
        `SELECT to_regclass('public.maintenance_records') IS NOT NULL AS present`,
      );
      if (!rows[0]?.present) {
        throw new Error(
          'Database is reachable but not migrated. Run: npm run migrate',
        );
      }
      this.log.log('PostgreSQL connection established and schema verified');
    } finally {
      client.release();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
