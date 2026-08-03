import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthService } from './auth.service';
import { AuthedUser, Role } from '../common/roles';
import { loadEnv } from '../config/env';

interface AccessTokenPayload {
  sub: string;
  role: Role;
  depotId: string | null;
  sid: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly auth: AuthService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: loadEnv().JWT_ACCESS_SECRET,
    });
  }

  /**
   * A valid signature is not sufficient. The session behind the token is
   * checked on every request so revoking a lost handset takes effect at once
   * rather than when the access token happens to expire.
   */
  async validate(payload: AccessTokenPayload): Promise<AuthedUser> {
    if (!(await this.auth.isSessionLive(payload.sid))) {
      throw new UnauthorizedException('Session has been revoked');
    }
    return {
      id: payload.sub,
      role: payload.role,
      depotId: payload.depotId,
      sessionId: payload.sid,
    };
  }
}
