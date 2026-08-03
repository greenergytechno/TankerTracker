import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export enum Role {
  Driver = 'driver',
  Dispatcher = 'dispatcher',
  FleetManager = 'fleet_manager',
  Admin = 'admin',
}

export interface AuthedUser {
  id: string;
  role: Role;
  depotId: string | null;
  sessionId: string;
}

export const ROLES_KEY = 'required_roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthedUser =>
    ctx.switchToHttp().getRequest().user,
);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No @Roles on the route means authentication alone is enough.
    if (!required || required.length === 0) return true;

    const user = context.switchToHttp().getRequest().user as AuthedUser | undefined;
    return Boolean(user && required.includes(user.role));
  }
}

/**
 * Depot scoping, applied on top of the role check. Drivers see only their own
 * trips; dispatchers only their depot; fleet managers and admins see the fleet.
 * Returns null when no depot filter should be applied.
 */
export function depotScopeFor(user: AuthedUser): string | null {
  return user.role === Role.Dispatcher ? user.depotId : null;
}
