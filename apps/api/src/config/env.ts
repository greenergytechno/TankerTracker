import { z } from 'zod';

/**
 * Environment contract. Parsed once at boot; a malformed value stops the
 * process rather than surfacing as a confusing runtime failure later.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().url().refine((v) => v.startsWith('postgres'), {
    message: 'DATABASE_URL must be a postgresql:// connection string',
  }),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),
  DATABASE_SSL: z.enum(['disable', 'require']).default('disable'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 chars'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(true),

  MAX_BILL_UPLOAD_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  RATE_LIMIT_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }

  const env = parsed.data;

  // Refusing to run production over a plaintext database link is deliberate:
  // GPS history and driver PII travel on this connection.
  if (env.NODE_ENV === 'production' && env.DATABASE_SSL !== 'require') {
    throw new Error('DATABASE_SSL must be "require" when NODE_ENV=production');
  }

  return env;
}
