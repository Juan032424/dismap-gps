import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { PositionsService } from './positions.service';

@Controller('devices/:id/positions')
export class PositionsController {
  constructor(private readonly positions: PositionsService) {}

  /** GET /devices/:id/positions?from=ISO&to=ISO&limit=N */
  @Get()
  history(
    @Param('id', ParseIntPipe) id: number,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    return this.positions.history(id, from, to, limit ? parseInt(limit, 10) : 1000);
  }
}
