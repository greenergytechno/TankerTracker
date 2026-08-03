import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';
import { MaintenanceService } from './maintenance.service';
import { CreateMaintenanceDto, MaintenanceQueryDto } from './maintenance.dto';
import { AuthedUser, CurrentUser, Role, Roles, RolesGuard } from '../common/roles';
import { loadEnv } from '../config/env';

/**
 * Cost data is management information, so drivers are excluded entirely —
 * every route here requires dispatcher or above.
 */
@Controller('maintenance')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(Role.Dispatcher, Role.FleetManager, Role.Admin)
export class MaintenanceController {
  constructor(private readonly maintenance: MaintenanceService) {}

  @Post('bills')
  @UseInterceptors(
    FileInterceptor('bill', { limits: { fileSize: loadEnv().MAX_BILL_UPLOAD_BYTES } }),
  )
  uploadBill(
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: AuthedUser,
  ) {
    if (!file) {
      throw new BadRequestException('No bill file was supplied.');
    }
    return this.maintenance.uploadBill(file, user);
  }

  @Post()
  create(@Body() dto: CreateMaintenanceDto, @CurrentUser() user: AuthedUser) {
    return this.maintenance.create(dto, user);
  }

  @Get()
  list(@Query() query: MaintenanceQueryDto) {
    return this.maintenance.list(query);
  }

  @Get('summary')
  summary() {
    return this.maintenance.summary();
  }

  @Get(':recordRef/bill')
  bill(@Param('recordRef') recordRef: string) {
    return this.maintenance.billDownloadUrl(recordRef);
  }
}
