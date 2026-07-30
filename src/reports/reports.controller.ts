import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { ReportsService } from './reports.service';

@Controller('devices/:id/report')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /** GET /devices/:id/report?from=ISO&to=ISO — resumen, viajes e histograma. */
  @Get()
  summary(
    @Param('id', ParseIntPipe) id: number,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reports.summary(id, from, to);
  }
}
