import { Body, Controller, Delete, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';
import { AuthService, TokenPair } from './auth.service';
import { AuthedUser, CurrentUser, Role, Roles, RolesGuard } from '../common/roles';

class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  /** Binds the session to one handset. */
  @IsString()
  @MinLength(8)
  deviceFingerprint!: string;

  @IsOptional()
  @IsString()
  deviceLabel?: string;
}

class RefreshDto {
  @IsString()
  refreshToken!: string;

  @IsString()
  deviceFingerprint!: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  login(@Body() dto: LoginDto): Promise<TokenPair> {
    return this.auth.login(dto.email, dto.password, dto.deviceFingerprint, dto.deviceLabel);
  }

  @Post('refresh')
  refresh(@Body() dto: RefreshDto): Promise<TokenPair> {
    return this.auth.refresh(dto.refreshToken, dto.deviceFingerprint);
  }

  /** Remote revocation for a lost or stolen phone. */
  @Delete('sessions/:id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(Role.FleetManager, Role.Admin)
  async revoke(
    @Param('id', ParseUUIDPipe) sessionId: string,
    @CurrentUser() user: AuthedUser,
  ): Promise<{ revoked: true }> {
    await this.auth.revokeSession(sessionId, user.id);
    return { revoked: true };
  }
}
