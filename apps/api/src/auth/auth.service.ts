import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseService } from '../db/database.service';
import { loadEnv } from '../config/env';
import { Role } from '../common/roles';

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  full_name: string;
  role: Role;
  depot_id: string | null;
  is_active: boolean;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

@Injectable()
export class AuthService {
  private readonly env = loadEnv();

  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
  ) {}

  private static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async login(
    email: string,
    password: string,
    deviceFingerprint: string,
    deviceLabel?: string,
  ): Promise<TokenPair> {
    const user = await this.db.one<UserRow>(
      `SELECT id, email, password_hash, full_name, role, depot_id, is_active
         FROM users WHERE email = $1`,
      [email],
    );

    // Compare against a dummy hash when the user is absent so that a missing
    // account and a wrong password take the same time to answer.
    const hash = user?.password_hash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
    const passwordMatches = await bcrypt.compare(password, hash);

    if (!user || !passwordMatches) {
      throw new UnauthorizedException('Invalid email or password');
    }
    if (!user.is_active) {
      throw new ForbiddenException('This account has been deactivated');
    }

    return this.issueSession(user, deviceFingerprint, deviceLabel);
  }

  private async issueSession(
    user: UserRow,
    deviceFingerprint: string,
    deviceLabel?: string,
  ): Promise<TokenPair> {
    const sessionId = randomUUID();
    const refreshToken = randomUUID() + randomUUID();

    const accessToken = await this.jwt.signAsync(
      { sub: user.id, role: user.role, depotId: user.depot_id, sid: sessionId },
      { secret: this.env.JWT_ACCESS_SECRET, expiresIn: this.env.JWT_ACCESS_TTL },
    );

    await this.db.transaction(async (client) => {
      // Logging in again on the same handset replaces the previous session
      // rather than accumulating live refresh tokens.
      await client.query(
        `UPDATE device_sessions
            SET revoked_at = now()
          WHERE user_id = $1 AND device_fingerprint = $2 AND revoked_at IS NULL`,
        [user.id, deviceFingerprint],
      );

      await client.query(
        `INSERT INTO device_sessions (id, user_id, device_fingerprint, device_label,
                                      refresh_token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + $6::interval)`,
        [
          sessionId,
          user.id,
          deviceFingerprint,
          deviceLabel ?? null,
          AuthService.hashToken(refreshToken),
          this.env.JWT_REFRESH_TTL.replace(/(\d+)d/, '$1 days').replace(/(\d+)m/, '$1 minutes'),
        ],
      );
    });

    return { accessToken, refreshToken, expiresIn: this.env.JWT_ACCESS_TTL };
  }

  async refresh(refreshToken: string, deviceFingerprint: string): Promise<TokenPair> {
    const session = await this.db.one<{ id: string; user_id: string }>(
      `SELECT s.id, s.user_id
         FROM device_sessions s
        WHERE s.refresh_token_hash = $1
          AND s.device_fingerprint = $2
          AND s.revoked_at IS NULL
          AND s.expires_at > now()`,
      [AuthService.hashToken(refreshToken), deviceFingerprint],
    );

    if (!session) {
      throw new UnauthorizedException('Refresh token is invalid, expired or revoked');
    }

    const user = await this.db.one<UserRow>(
      `SELECT id, email, password_hash, full_name, role, depot_id, is_active
         FROM users WHERE id = $1`,
      [session.user_id],
    );
    if (!user || !user.is_active) {
      throw new ForbiddenException('This account has been deactivated');
    }

    return this.issueSession(user, deviceFingerprint);
  }

  /** Used when a driver loses a handset. */
  async revokeSession(sessionId: string, revokedBy: string): Promise<void> {
    await this.db.query(
      `UPDATE device_sessions
          SET revoked_at = now(), revoked_by = $2
        WHERE id = $1 AND revoked_at IS NULL`,
      [sessionId, revokedBy],
    );
  }

  async isSessionLive(sessionId: string): Promise<boolean> {
    const row = await this.db.one<{ ok: boolean }>(
      `SELECT true AS ok FROM device_sessions
        WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [sessionId],
    );
    return Boolean(row);
  }
}
