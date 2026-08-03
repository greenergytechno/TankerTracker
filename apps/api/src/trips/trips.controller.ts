import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TripsService } from './trips.service';
import { AddExpenseDto, EndTripDto, LogStopDto, ScheduleTripDto, StartTripDto } from './trips.dto';
import { AuthedUser, CurrentUser, Role, Roles, RolesGuard } from '../common/roles';

@Controller('trips')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class TripsController {
  constructor(private readonly trips: TripsService) {}

  /** Dispatch creates the trip sheet and hands the Trip ID to the driver. */
  @Post()
  @Roles(Role.Dispatcher, Role.FleetManager, Role.Admin)
  schedule(@Body() dto: ScheduleTripDto, @CurrentUser() user: AuthedUser) {
    return this.trips.schedule(dto, user);
  }

  @Get()
  list(@CurrentUser() user: AuthedUser, @Query('status') status?: string) {
    return this.trips.list(user, status);
  }

  @Get(':tripRef')
  report(@Param('tripRef') tripRef: string, @CurrentUser() user: AuthedUser) {
    return this.trips.report(tripRef, user);
  }

  @Post(':tripRef/depart')
  @Roles(Role.Driver)
  start(
    @Param('tripRef') tripRef: string,
    @Body() dto: StartTripDto,
    @CurrentUser() user: AuthedUser,
  ) {
    return this.trips.start(tripRef, dto, user);
  }

  @Post(':tripRef/stops')
  @Roles(Role.Driver)
  logStop(
    @Param('tripRef') tripRef: string,
    @Body() dto: LogStopDto,
    @CurrentUser() user: AuthedUser,
  ) {
    return this.trips.logStop(tripRef, dto, user);
  }

  @Post(':tripRef/arrive')
  @Roles(Role.Driver)
  end(
    @Param('tripRef') tripRef: string,
    @Body() dto: EndTripDto,
    @CurrentUser() user: AuthedUser,
  ) {
    return this.trips.end(tripRef, dto, user);
  }

  /**
   * Expenses are the driver's only write access to a trip's money. There is
   * deliberately no route for a driver to change the advance, invoice or any
   * scheduling field — those belong to dispatch.
   */
  @Post(':tripRef/expenses')
  @Roles(Role.Driver)
  logExpense(
    @Param('tripRef') tripRef: string,
    @Body() dto: AddExpenseDto,
    @CurrentUser() user: AuthedUser,
  ) {
    return this.trips.logExpense(tripRef, dto, user);
  }
}
